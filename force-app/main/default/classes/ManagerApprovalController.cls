public without sharing class ManagerApprovalController {

    // ==========================================
    // 1. DATA WRAPPERS (With Enterprise Stats)
    // ==========================================
    public class ApprovalHubWrapper {
        @AuraEnabled public String projectId { get; set; }
        @AuraEnabled public String projectName { get; set; }
        @AuraEnabled public Decimal totalPendingHours { get; set; }
        @AuraEnabled public Integer totalPendingTimesheets { get; set; }
        @AuraEnabled public List<CandidateGroup> candidates { get; set; }
        
        public ApprovalHubWrapper() {
            this.candidates = new List<CandidateGroup>();
            this.totalPendingHours = 0.0;
            this.totalPendingTimesheets = 0;
        }
    }

    public class CandidateGroup {
        @AuraEnabled public String candidateId { get; set; }
        @AuraEnabled public String candidateName { get; set; }
        @AuraEnabled public String initials { get; set; }
        @AuraEnabled public Decimal totalWeeklyHours { get; set; }
        @AuraEnabled public Boolean hasExceptions { get; set; } 
        @AuraEnabled public List<Time_Entry__c> entries { get; set; }
        
        public CandidateGroup() {
            this.entries = new List<Time_Entry__c>();
            this.totalWeeklyHours = 0.0;
            this.hasExceptions = false;
        }
    }

    // 🌟 ENTERPRISE DYNAMIC ID RESOLUTION
    private static Id getLoggedInManagerId() {
        Id currentUserId = UserInfo.getUserId();
        // Check if the user is a Portal/Experience Cloud user with a Contact
        List<User> currentUser = [SELECT ContactId FROM User WHERE Id = :currentUserId LIMIT 1];
        
        if (!currentUser.isEmpty() && currentUser[0].ContactId != null) {
            return currentUser[0].ContactId; // Portal User
        }
        return '003gK00000TND8jQAH'; // Internal Salesforce User
    }

    // ==========================================
    // 2. THE SWEEP: FETCH ALL PROJECTS & PENDING TIMESHEETS
    // ==========================================
    @AuraEnabled(cacheable=true)
    public static List<ApprovalHubWrapper> getPendingApprovals() {
        try {
            // NOTE: Replace with UserInfo.getUserId() logic later if needed
            Id managerContactId = getLoggedInManagerId();

            Map<Id, ApprovalHubWrapper> projectMap = new Map<Id, ApprovalHubWrapper>();
            Map<String, CandidateGroup> candidateMap = new Map<String, CandidateGroup>();

            // 🌟 STEP A: FETCH ALL PROJECTS (Ensures Inbox Zero projects appear)
            List<Project__c> myProjects = [
                SELECT Id, Name FROM Project__c 
                WHERE Timesheet_Approver__c = :managerContactId 
                ORDER BY Name
            ];
            
            for (Project__c p : myProjects) {
                ApprovalHubWrapper pWrap = new ApprovalHubWrapper();
                pWrap.projectId = p.Id;
                pWrap.projectName = p.Name;
                projectMap.put(p.Id, pWrap);
            }

            // 🌟 STEP B: FETCH PENDING ENTRIES
            String query = 'SELECT Id, Date__c, Hours_Worked_Number_Format__c, Additional_Comments__c, ' +
                           'Time_Status__c, Task__c, Task__r.Name, ' +
                           'Project__c, Project__r.Name, Project__r.Timesheet_Approver__c, ' + 
                           'Project_Resource__r.Candidate_Employee__c, ' +
                           'Project_Resource__r.Candidate_Employee__r.Name ' +
                           'FROM Time_Entry__c ' +
                           'WHERE Time_Status__c = \'Submitted\' ';
            
            if (managerContactId != null) {
                query += 'AND Project__r.Timesheet_Approver__c = :managerContactId ';
            }
            query += 'ORDER BY Project__r.Name, Project_Resource__r.Candidate_Employee__r.Name, Date__c ASC';

            List<Time_Entry__c> pendingEntries = Database.query(query);

            // 🌟 STEP C: MAP ENTRIES AND CALCULATE STATS
            for (Time_Entry__c te : pendingEntries) {
                Id pId = te.Project__c;
                Id cId = te.Project_Resource__r.Candidate_Employee__c;
                String candName = te.Project_Resource__r.Candidate_Employee__r.Name;
                
                if (String.isBlank(candName)) candName = 'Unknown Resource';
                if (!projectMap.containsKey(pId)) continue; // Safety check

                Decimal hrs = te.Hours_Worked_Number_Format__c != null ? te.Hours_Worked_Number_Format__c : 0;
                
                // Update Project-Level Totals
                projectMap.get(pId).totalPendingHours += hrs;
                projectMap.get(pId).totalPendingTimesheets += 1;

                String compKey = String.valueOf(pId) + '_' + String.valueOf(cId);
                if (!candidateMap.containsKey(compKey)) {
                    CandidateGroup cGroup = new CandidateGroup();
                    cGroup.candidateId = cId;
                    cGroup.candidateName = candName;
                    cGroup.initials = getInitials(candName);
                    candidateMap.put(compKey, cGroup);
                    
                    projectMap.get(pId).candidates.add(cGroup);
                }

                CandidateGroup cg = candidateMap.get(compKey);
                cg.entries.add(te);
                cg.totalWeeklyHours += hrs;

                if (String.isBlank(te.Additional_Comments__c) || hrs > 8.0) {
                    cg.hasExceptions = true;
                }
            }

            for (CandidateGroup cg : candidateMap.values()) {
                if (cg.totalWeeklyHours > 40.0) cg.hasExceptions = true;
            }

            return projectMap.values();

        } catch (Exception e) {
            throw handleException('Failed to load approval dashboard', e);
        }
    }

    // ==========================================
    // 3. GET MANAGER CONTEXT (Global Header)
    // ==========================================
    @AuraEnabled(cacheable=true)
    public static Map<String, String> getManagerContext() {
        // 🌟 REMOVED HARDCODED ID - Now uses the dynamic method
        Id managerId = getLoggedInManagerId(); 
        
        Map<String, String> ctx = new Map<String, String>();
        
        List<Contact> managers = [SELECT Name, Title FROM Contact WHERE Id = :managerId LIMIT 1];
        if(!managers.isEmpty()) {
            ctx.put('name', managers[0].Name);
            ctx.put('role', String.isNotBlank(managers[0].Title) ? managers[0].Title : 'Operations Manager');
            ctx.put('initials', getInitials(managers[0].Name));
        } else {
            // This is what shows if an internal Admin tests the component without a Contact record
            ctx.put('name', UserInfo.getName()); 
            ctx.put('role', 'System Administrator');
            ctx.put('initials', 'SA');
        }
        return ctx;
    }

    // ==========================================
    // 4. BULK ACTIONS (Approve / Reject)
    // ==========================================
    @AuraEnabled
    public static String processTimesheets(Id projectId, Id candidateId, String action, String rejectReason) {
        Savepoint sp = Database.setSavepoint();
        try {
            List<Time_Entry__c> entries = [
                SELECT Id, Time_Status__c 
                FROM Time_Entry__c 
                WHERE Project__c = :projectId 
                AND Project_Resource__r.Candidate_Employee__c = :candidateId 
                AND Time_Status__c = 'Submitted'
                FOR UPDATE
            ];

            if (entries.isEmpty()) return 'No submitted entries found to process.';
            String newStatus = (action == 'Approve') ? 'Approved' : 'Rejected';

            for (Time_Entry__c te : entries) {
                te.Time_Status__c = newStatus;
            }
            update entries;
            return 'Successfully ' + newStatus.toLowerCase() + ' ' + entries.size() + ' entries.';
        } catch (Exception e) {
            Database.rollback(sp);
            throw handleException('Failed to process timesheets', e);
        }
    }

    // ==========================================
    // 5. SPLIT & RECLASSIFY TIME
    // ==========================================
    @AuraEnabled
    public static String splitAndReclassifyTime(Id originalEntryId, Decimal regularHours, Decimal exceptionHours, Id exceptionTaskId, String auditNotes) {
        Savepoint sp = Database.setSavepoint();
        try {
            Time_Entry__c original = [
                SELECT Id, Date__c, Project__c, Project_Resource__c, Additional_Comments__c, 
                       Start_Time__c, End_Time__c, Hours_Worked_Number_Format__c, Task__c
                FROM Time_Entry__c 
                WHERE Id = :originalEntryId LIMIT 1 FOR UPDATE
            ];

            original.Hours_Worked_Number_Format__c = regularHours;
            original.Start_Time__c = null; 
            original.End_Time__c = null;

            Time_Entry__c splitEntry = original.clone(false, true, false, false);
            splitEntry.Hours_Worked_Number_Format__c = exceptionHours;
            splitEntry.Task__c = exceptionTaskId; 
            splitEntry.Time_Status__c = 'Submitted'; 

            update original;
            insert splitEntry;
            return 'Time successfully split and reclassified.';
        } catch (Exception e) {
            Database.rollback(sp);
            throw handleException('Failed to split time entry', e);
        }
    }

    // 🌟 FETCH INDIVIDUAL EXPENSES (FLAT LIST WITH FILES)
    @AuraEnabled(cacheable=true)
    public static List<Expense__c> getPendingExpenses() {
        Id managerId = getLoggedInManagerId();
        
        return [
            SELECT Id, Name, Amount__c, Expense_Date__c, Category__c, Description__c, 
                   Contact__r.Name, Project__r.Name,
                   
                   // 🌟 THE ENTERPRISE FIX: Fetch the actual attached file!
                   (SELECT ContentDocumentId, ContentDocument.Title, ContentDocument.ContentSize, ContentDocument.FileExtension 
                    FROM ContentDocumentLinks 
                    LIMIT 1)
                    
            FROM Expense__c 
            WHERE Status__c = 'Submitted' 
            AND Project__r.Timesheet_Approver__c = :managerId
            ORDER BY Expense_Date__c ASC
            LIMIT 1000
        ];
    }

    

    // ==========================================
    // 6. UTILITIES
    // ==========================================
    @AuraEnabled(cacheable=true)
    public static List<Map<String, String>> getActiveTasks() {
        List<Map<String, String>> taskList = new List<Map<String, String>>();
        for (Task__c t : [SELECT Id, Name FROM Task__c ORDER BY Name LIMIT 50]) {
            Map<String, String> tMap = new Map<String, String>();
            tMap.put('label', t.Name);
            tMap.put('value', t.Id);
            taskList.add(tMap);
        }
        return taskList;
    }

    private static String getInitials(String fullName) {
        if (String.isBlank(fullName)) return '??';
        List<String> parts = fullName.trim().split(' ');
        if (parts.size() == 1) return parts[0].substring(0, 1).toUpperCase();
        return (parts[0].substring(0, 1) + parts[parts.size() - 1].substring(0, 1)).toUpperCase();
    }

    private static AuraHandledException handleException(String msg, Exception e) {
        String log = msg + ' | ' + (e != null ? e.getMessage() : '');
        System.debug(LoggingLevel.ERROR, log);
        AuraHandledException auraEx = new AuraHandledException(log);
        auraEx.setMessage(log);
        return auraEx;
    }
}