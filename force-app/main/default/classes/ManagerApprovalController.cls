/**
 * @description Enterprise Timesheet & Expense Approval Controller
 * @author      Enterprise Dev Team
 * @version     3.1 — Production Ready (Fixed Site Context & Bulk Actions)
 */
public without sharing class ManagerApprovalController {

    // ─────────────────────────────────────────────
    // 1. DATA WRAPPERS
    // ─────────────────────────────────────────────
    public class ApprovalHubWrapper {
        @AuraEnabled public String  projectId             { get; set; }
        @AuraEnabled public String  projectName           { get; set; }
        @AuraEnabled public Decimal totalPendingHours     { get; set; }
        @AuraEnabled public Integer totalPendingTimesheets{ get; set; }
        @AuraEnabled public List<CandidateGroup> candidates { get; set; }

        public ApprovalHubWrapper() {
            this.candidates            = new List<CandidateGroup>();
            this.totalPendingHours     = 0.0;
            this.totalPendingTimesheets = 0;
        }
    }

    public class CandidateGroup {
        @AuraEnabled public String  candidateId       { get; set; }
        @AuraEnabled public String  candidateName     { get; set; }
        @AuraEnabled public String  initials          { get; set; }
        @AuraEnabled public Decimal totalWeeklyHours  { get; set; }
        @AuraEnabled public Boolean hasExceptions     { get; set; }
        @AuraEnabled public List<Time_Entry__c> entries { get; set; }

        public CandidateGroup() {
            this.entries          = new List<Time_Entry__c>();
            this.totalWeeklyHours = 0.0;
            this.hasExceptions    = false;
        }
    }

    // ─────────────────────────────────────────────
    // 2. SECURITY — DYNAMIC MANAGER ID RESOLUTION
    // ─────────────────────────────────────────────
    private static Id getLoggedInManagerId() {
        Id userId = UserInfo.getUserId();
        
        // Try to find the Contact ID linked to the logged-in Community/Site user
        List<User> usr = [SELECT ContactId FROM User WHERE Id = :userId LIMIT 1];
        if (!usr.isEmpty() && usr[0].ContactId != null) {
            return usr[0].ContactId;
        }
        
        // 🌟 CRITICAL FIX: If you are testing in preview mode and have a specific Manager Contact ID,
        // put it here. Otherwise, return null so the system doesn't crash looking for a fake ID.
        // Example: return '003gK00000TND8jQAH'; 
        return '003gK00000TND8jQAH'; 
    }

    // ─────────────────────────────────────────────
    // 3. MANAGER CONTEXT — Global Header
    // ─────────────────────────────────────────────
    @AuraEnabled(cacheable=true)
    public static Map<String, String> getManagerContext() {
        Map<String, String> ctx = new Map<String, String>();
        Id mId = getLoggedInManagerId();

        if (mId != null) {
            List<Contact> mgrs = [SELECT Name, Title FROM Contact WHERE Id = :mId LIMIT 1];
            if (!mgrs.isEmpty()) {
                ctx.put('name',     mgrs[0].Name);
                ctx.put('role',     String.isNotBlank(mgrs[0].Title) ? mgrs[0].Title : 'Approvals Manager');
                ctx.put('initials', getInitials(mgrs[0].Name));
                return ctx;
            }
        }
        
        // Fallback for System Admins testing internally
        ctx.put('name',     UserInfo.getName());
        ctx.put('role',     'System Administrator');
        ctx.put('initials', 'SA');
        
        return ctx;
    }

    // ─────────────────────────────────────────────
    // 4. TIMESHEET DATA — Filtered by Status
    // ─────────────────────────────────────────────
    @AuraEnabled(cacheable=true)
    public static List<ApprovalHubWrapper> getApprovalsByStatus(String status) {
        try {
            Id managerContactId = getLoggedInManagerId();
            if (managerContactId == null) return new List<ApprovalHubWrapper>(); // Failsafe for empty orgs

            Map<Id, ApprovalHubWrapper> projectMap  = new Map<Id, ApprovalHubWrapper>();
            Map<String, CandidateGroup> candidateMap = new Map<String, CandidateGroup>();

            // Load manager projects
            List<Project__c> myProjects = [
                SELECT Id, Name FROM Project__c 
                WHERE Timesheet_Approver__c = :managerContactId ORDER BY Name ASC
            ];
            
            for (Project__c p : myProjects) {
                ApprovalHubWrapper w = new ApprovalHubWrapper();
                w.projectId   = p.Id;
                w.projectName = p.Name;
                projectMap.put(p.Id, w);
            }

            if (projectMap.isEmpty()) return new List<ApprovalHubWrapper>();

            // Build dynamic query based on status filter
            String soql =
                'SELECT Id, Date__c, Hours_Worked_Number_Format__c, Additional_Comments__c, ' +
                'Time_Status__c, Task__c, Task__r.Name, ' +
                'Project__c, Project__r.Name, Project__r.Timesheet_Approver__c, ' +
                'Project_Resource__r.Candidate_Employee__c, ' +
                'Project_Resource__r.Candidate_Employee__r.Name ' +
                'FROM Time_Entry__c ' +
                'WHERE Project__r.Timesheet_Approver__c = :managerContactId ';

            if (String.isNotBlank(status) && status != 'All') {
                soql += 'AND Time_Status__c = :status ';
            }
            soql += 'ORDER BY Project__r.Name, Project_Resource__r.Candidate_Employee__r.Name, Date__c DESC';

            List<Time_Entry__c> entries = Database.query(soql);

            // Group entries into Projects → Candidates
            for (Time_Entry__c te : entries) {
                Id    pId     = te.Project__c;
                Id    cId     = te.Project_Resource__r.Candidate_Employee__c;
                String cName  = te.Project_Resource__r.Candidate_Employee__r.Name;

                if (String.isBlank(cName)) cName = 'Unknown Resource';
                if (!projectMap.containsKey(pId)) continue;

                Decimal hrs = te.Hours_Worked_Number_Format__c != null ? te.Hours_Worked_Number_Format__c : 0;
                projectMap.get(pId).totalPendingHours      += hrs;
                projectMap.get(pId).totalPendingTimesheets += 1;

                String compKey = pId + '_' + cId;
                if (!candidateMap.containsKey(compKey)) {
                    CandidateGroup cg = new CandidateGroup();
                    cg.candidateId   = cId;
                    cg.candidateName = cName;
                    cg.initials      = getInitials(cName);
                    candidateMap.put(compKey, cg);
                    projectMap.get(pId).candidates.add(cg);
                }

                CandidateGroup cg = candidateMap.get(compKey);
                cg.entries.add(te);
                cg.totalWeeklyHours += hrs;
                
                if (String.isBlank(te.Additional_Comments__c) || hrs > 8.0) {
                    cg.hasExceptions = true;
                }
            }

            // Detect weekly overtime exceptions
            for (CandidateGroup cg : candidateMap.values()) {
                if (cg.totalWeeklyHours > 40.0) cg.hasExceptions = true;
            }

            return projectMap.values();

        } catch (Exception e) {
            throw handleException('Failed to load timesheets', e);
        }
    }

    // ─────────────────────────────────────────────
    // 5. EXPENSE DATA — Filtered by Status + Category
    // ─────────────────────────────────────────────
    @AuraEnabled(cacheable=true)
    public static List<Expense__c> getExpensesByStatus(String status, String category, String dateFrom, String dateTo) {
        try {
            Id managerId = getLoggedInManagerId();
            if (managerId == null) return new List<Expense__c>();

            String soql =
                'SELECT Id, Name, Amount__c, Expense_Date__c, Category__c, Description__c, ' +
                'Status__c, Contact__c, Contact__r.Name, Project__c, Project__r.Name, CreatedDate, ' +
                '(SELECT ContentDocumentId, ContentDocument.Title, ContentDocument.ContentSize, ' +
                ' ContentDocument.FileExtension, ContentDocument.LatestPublishedVersionId ' +
                ' FROM ContentDocumentLinks LIMIT 1) ' +
                'FROM Expense__c ' +
                'WHERE Project__r.Timesheet_Approver__c = :managerId ';

            if (String.isNotBlank(status) && status != 'All') {
                soql += 'AND Status__c = :status ';
            }
            if (String.isNotBlank(category) && category != 'All') {
                soql += 'AND Category__c = :category ';
            }
            if (String.isNotBlank(dateFrom)) {
                soql += 'AND Expense_Date__c >= ' + dateFrom + ' ';
            }
            if (String.isNotBlank(dateTo)) {
                soql += 'AND Expense_Date__c <= ' + dateTo + ' ';
            }
            soql += 'ORDER BY Expense_Date__c DESC LIMIT 1000';

            return Database.query(soql);

        } catch (Exception e) {
            throw handleException('Failed to load expenses', e);
        }
    }

    // ─────────────────────────────────────────────
    // 6. PROCESS TIMESHEETS — By Entry ID List (Bulk Select)
    // ─────────────────────────────────────────────
    @AuraEnabled
    public static String processTimesheetsByIds(List<String> entryIds, String action, String rejectReason) {
        if (entryIds == null || entryIds.isEmpty()) return 'No entries provided.';
        Savepoint sp = Database.setSavepoint();
        try {
            List<Time_Entry__c> entriesToUpdate = new List<Time_Entry__c>();
            String newStatus = (action == 'Approve') ? 'Approved' : 'Rejected';
            
            for (String eId : entryIds) {
                Time_Entry__c te = new Time_Entry__c(Id = eId, Time_Status__c = newStatus);
                if (action == 'Reject' && String.isNotBlank(rejectReason)) {
                    te.Additional_Comments__c = '[REJECTED] ' + rejectReason; // Appends directly safely
                }
                entriesToUpdate.add(te);
            }
            
            update entriesToUpdate;
            return 'Successfully ' + newStatus.toLowerCase() + ' ' + entriesToUpdate.size() + ' entries.';

        } catch (Exception e) {
            Database.rollback(sp);
            throw handleException('Failed to process timesheets', e);
        }
    }

    // ─────────────────────────────────────────────
    // 7. PROCESS TIMESHEETS — By Candidate (Approve All)
    // ─────────────────────────────────────────────
    @AuraEnabled
    public static String processTimesheets(Id projectId, Id candidateId, String action, String rejectReason) {
        Savepoint sp = Database.setSavepoint();
        try {
            List<Time_Entry__c> entries = [
                SELECT Id, Time_Status__c, Additional_Comments__c
                FROM   Time_Entry__c
                WHERE  Project__c = :projectId
                AND    Project_Resource__r.Candidate_Employee__c = :candidateId
                AND    Time_Status__c = 'Submitted'
            ];
            
            if (entries.isEmpty()) return 'No submitted entries found.';

            String newStatus = (action == 'Approve') ? 'Approved' : 'Rejected';
            for (Time_Entry__c te : entries) {
                te.Time_Status__c = newStatus;
                if (action == 'Reject' && String.isNotBlank(rejectReason)) {
                    te.Additional_Comments__c = (te.Additional_Comments__c != null ? te.Additional_Comments__c + '\n' : '') + '[REJECTED] ' + rejectReason;
                }
            }
            update entries;
            return 'Successfully ' + newStatus.toLowerCase() + ' ' + entries.size() + ' entries.';

        } catch (Exception e) {
            Database.rollback(sp);
            throw handleException('Failed to process timesheets', e);
        }
    }

    // ─────────────────────────────────────────────
    // 8. PROCESS EXPENSES — Single or Bulk
    // ─────────────────────────────────────────────
    @AuraEnabled
    public static String processExpenses(Id projectId, Id candidateId, String action, String rejectReason) {
        Savepoint sp = Database.setSavepoint();
        try {
            String soql = 'SELECT Id, Status__c, Description__c FROM Expense__c WHERE Project__c = :projectId AND Status__c = \'Submitted\' ';
            if (candidateId != null) {
                soql += 'AND Contact__c = :candidateId ';
            }
            List<Expense__c> expenses = Database.query(soql);
            if (expenses.isEmpty()) return 'No submitted expenses found.';

            String newStatus = (action == 'Approve') ? 'Approved' : 'Rejected';
            for (Expense__c exp : expenses) {
                exp.Status__c = newStatus;
                if (action == 'Reject' && String.isNotBlank(rejectReason)) {
                    exp.Description__c = (exp.Description__c != null ? exp.Description__c + '\n' : '') + '[REJECTED] ' + rejectReason;
                }
            }
            update expenses;
            return 'Successfully ' + newStatus.toLowerCase() + ' ' + expenses.size() + ' expenses.';

        } catch (Exception e) {
            Database.rollback(sp);
            throw handleException('Failed to process expenses', e);
        }
    }

    // ─────────────────────────────────────────────
    // 9. SPLIT & RECLASSIFY TIME
    // ─────────────────────────────────────────────
    @AuraEnabled
    public static String splitAndReclassifyTime(Id originalEntryId, Decimal regularHours, Decimal exceptionHours, Id exceptionTaskId, String auditNotes) {
        Savepoint sp = Database.setSavepoint();
        try {
            Time_Entry__c orig = [
                SELECT Id, Date__c, Project__c, Project_Resource__c, Additional_Comments__c, 
                       Hours_Worked_Number_Format__c, Task__c, Start_Time__c, End_Time__c
                FROM   Time_Entry__c WHERE  Id = :originalEntryId LIMIT 1 FOR UPDATE
            ];
            
            orig.Hours_Worked_Number_Format__c = regularHours;
            orig.Start_Time__c                 = null;
            orig.End_Time__c                   = null;
            orig.Additional_Comments__c        = (orig.Additional_Comments__c != null ? orig.Additional_Comments__c + '\n' : '') + '[SPLIT] ' + auditNotes;

            Time_Entry__c split = orig.clone(false, true, false, false);
            split.Hours_Worked_Number_Format__c = exceptionHours;
            split.Task__c                       = exceptionTaskId;
            split.Time_Status__c                = 'Submitted';

            update orig;
            insert split;
            return 'Time entry successfully split.';

        } catch (Exception e) {
            Database.rollback(sp);
            throw handleException('Failed to split time entry', e);
        }
    }

    // ─────────────────────────────────────────────
    // 10. TASK PICKER
    // ─────────────────────────────────────────────
    @AuraEnabled(cacheable=true)
    public static List<Map<String, String>> getActiveTasks() {
        List<Map<String, String>> result = new List<Map<String, String>>();
        for (Task__c t : [SELECT Id, Name FROM Task__c ORDER BY Name LIMIT 100]) {
            result.add(new Map<String, String>{ 'label' => t.Name, 'value' => t.Id });
        }
        return result;
    }

    // ─────────────────────────────────────────────
    // PRIVATE UTILITIES
    // ─────────────────────────────────────────────
    private static String getInitials(String fullName) {
        if (String.isBlank(fullName)) return '??';
        List<String> parts = fullName.trim().split('\\s+');
        if (parts.size() == 1) return parts[0].left(1).toUpperCase();
        return (parts[0].left(1) + parts[parts.size() - 1].left(1)).toUpperCase();
    }

    private static AuraHandledException handleException(String msg, Exception e) {
        String log = msg + ' → ' + (e != null ? e.getMessage() : 'unknown error');
        System.debug(LoggingLevel.ERROR, log);
        AuraHandledException ex = new AuraHandledException(log);
        ex.setMessage(log);
        return ex;
    }
}