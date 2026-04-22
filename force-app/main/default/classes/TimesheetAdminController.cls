public without sharing class TimesheetAdminController {
    
    // 🌟 TEMPORARY HARDCODE FOR DEVELOPMENT
    private static final Id HARDCODED_ADMIN_CONTACT_ID = '003gK00000TND8jQAH'; 

    // ==========================================
    // DATA WRAPPERS
    // ==========================================
    public class ApprovalDashboardWrapper {
        @AuraEnabled public Integer globalTotalPending { get; set; } 
        @AuraEnabled public Decimal globalTotalHours { get; set; }   
        @AuraEnabled public Integer globalTotalPendingExpenses { get; set; } // 🌟 NEW
        @AuraEnabled public Decimal globalTotalExpenseAmount { get; set; }   // 🌟 NEW
        @AuraEnabled public List<ProjectWrapper> projects { get; set; }
        @AuraEnabled public Map<Id, List<Id>> expenseToAttachments { get; set; } // 🌟 NEW: Links Receipts to Expenses
        
        public ApprovalDashboardWrapper() {
            this.globalTotalPending = 0;
            this.globalTotalHours = 0.0;
            this.globalTotalPendingExpenses = 0;
            this.globalTotalExpenseAmount = 0.0;
            this.projects = new List<ProjectWrapper>();
            this.expenseToAttachments = new Map<Id, List<Id>>();
        }
    } 

    public class ProjectWrapper {
        @AuraEnabled public String projectId { get; set; }
        @AuraEnabled public String projectName { get; set; }
        @AuraEnabled public List<ResourceWrapper> resources { get; set; }
        @AuraEnabled public List<Map<String, String>> taskOptions { get; set; } 

        public ProjectWrapper(String pId, String pName) {
            this.projectId = pId;
            this.projectName = pName;
            this.resources = new List<ResourceWrapper>();
            this.taskOptions = new List<Map<String, String>>{ new Map<String, String>{'label' => 'All Tasks', 'value' => 'All'} };
        }
    }

    public class ResourceWrapper {
        @AuraEnabled public String resourceId { get; set; }
        @AuraEnabled public String candidateName { get; set; }
        @AuraEnabled public List<Time_Entry__c> timeEntries { get; set; }
        @AuraEnabled public List<Expense__c> expenses { get; set; }
        
        public ResourceWrapper(String rId, String cName) {
            this.resourceId = rId;
            this.candidateName = cName;
            this.timeEntries = new List<Time_Entry__c>();
            this.expenses = new List<Expense__c>();
        }
    }

    // ==========================================
    // ENTERPRISE BULK ACTIONS
    // ==========================================
    @AuraEnabled
    public static String processTimesheetAction(List<Id> entryIds, String action) {
        if (entryIds == null || entryIds.isEmpty()) return 'No records.';
        try {
            List<Time_Entry__c> updates = new List<Time_Entry__c>();
            String status = (action == 'Approve') ? 'Approved' : 'Rejected';
            Datetime now = System.now();
            for(Id eId : entryIds) updates.add(new Time_Entry__c(Id = eId, Time_Status__c = status, Approval_Date_Time__c = now, Approver__c = HARDCODED_ADMIN_CONTACT_ID));
            update updates;
            return 'Success';
        } catch (Exception e) { throw new AuraHandledException(e.getMessage()); }
    }

    // 🌟 NEW: Process Expenses Method
    @AuraEnabled
    public static String processExpenseAction(List<Id> expenseIds, String action) {
        if (expenseIds == null || expenseIds.isEmpty()) return 'No records.';
        try {
            List<Expense__c> updates = new List<Expense__c>();
            String status = (action == 'Approve') ? 'Approved' : 'Rejected';
            Date today = Date.today();
            for(Id eId : expenseIds) updates.add(new Expense__c(Id = eId, Status__c = status, Approval_Date__c = today, Expense_Approver__c = HARDCODED_ADMIN_CONTACT_ID));
            update updates;
            return 'Success';
        } catch (Exception e) { throw new AuraHandledException(e.getMessage()); }
    }

    // ==========================================
    // MAIN FETCH METHOD
    // ==========================================
    @AuraEnabled(cacheable=true)
    public static ApprovalDashboardWrapper getApprovalData() {
        ApprovalDashboardWrapper dashboard = new ApprovalDashboardWrapper();
        Id mgrId = HARDCODED_ADMIN_CONTACT_ID;
        
        try {
            Map<Id, Project__c> projectBaseMap = new Map<Id, Project__c>([SELECT Id, Name, (SELECT Id, Name FROM Tasks__r ORDER BY Name ASC) FROM Project__c WHERE Timesheet_Approver__c = :mgrId]);
            if (projectBaseMap.isEmpty()) return dashboard;

            Map<Id, ProjectWrapper> pWrapperMap = new Map<Id, ProjectWrapper>();
            Map<String, ResourceWrapper> rWrapperMap = new Map<String, ResourceWrapper>(); 

            for (Project__c p : projectBaseMap.values()) {
                ProjectWrapper pw = new ProjectWrapper(p.Id, p.Name);
                if (p.Tasks__r != null) for (Task__c t : p.Tasks__r) pw.taskOptions.add(new Map<String, String>{'label' => t.Name, 'value' => t.Name});
                pWrapperMap.put(p.Id, pw);
            }

            // TIMESHEETS
            List<Time_Entry__c> timeEntries = [SELECT Id, Date__c, Hours_Worked_Number_Format__c, Time_Status__c, Additional_Comments__c, Project__c, Project_Resource__c, Project_Resource__r.Candidate_Employee__r.Name, Task__r.Name FROM Time_Entry__c WHERE Project__c IN :projectBaseMap.keySet() AND Time_Status__c IN ('Submitted', 'Approved', 'Rejected') ORDER BY Date__c DESC];
            for (Time_Entry__c te : timeEntries) {
                String pId = te.Project__c; String rId = te.Project_Resource__c; String compKey = pId + '_' + rId;
                String candName = te.Project_Resource__r?.Candidate_Employee__r?.Name; if (String.isBlank(candName)) candName = 'Unknown Candidate';

                if (te.Time_Status__c == 'Submitted') {
                    dashboard.globalTotalPending++;
                    dashboard.globalTotalHours += (te.Hours_Worked_Number_Format__c != null ? te.Hours_Worked_Number_Format__c : 0);
                }

                if (!rWrapperMap.containsKey(compKey)) { rWrapperMap.put(compKey, new ResourceWrapper(rId, candName)); pWrapperMap.get(pId).resources.add(rWrapperMap.get(compKey)); }
                rWrapperMap.get(compKey).timeEntries.add(te);
            }

            // EXPENSES
            Map<Id, Expense__c> expenseMap = new Map<Id, Expense__c>([SELECT Id, Name, Amount__c, Expense_Date__c, Category__c, Status__c, Description__c, Comments__c, Project__c, Contact__r.Name, Contact__c FROM Expense__c WHERE Project__c IN :projectBaseMap.keySet() AND Status__c IN ('Submitted', 'Approved', 'Rejected') ORDER BY Expense_Date__c DESC]);
            
            for (Expense__c exp : expenseMap.values()) {
                String pId = exp.Project__c; String cId = exp.Contact__c; String compKey = pId + '_EXP_' + cId;
                String candName = exp.Contact__r?.Name; if (String.isBlank(candName)) candName = 'Unknown Contact';

                if (exp.Status__c == 'Submitted') {
                    dashboard.globalTotalPendingExpenses++;
                    dashboard.globalTotalExpenseAmount += (exp.Amount__c != null ? exp.Amount__c : 0);
                }

                if (!rWrapperMap.containsKey(compKey)) { rWrapperMap.put(compKey, new ResourceWrapper(cId, candName)); pWrapperMap.get(pId).resources.add(rWrapperMap.get(compKey)); }
                rWrapperMap.get(compKey).expenses.add(exp);
            }

            // 🌟 NEW: Fetch Receipts/Attachments for these Expenses
            if(!expenseMap.isEmpty()){
                List<ContentDocumentLink> cdls = [SELECT LinkedEntityId, ContentDocumentId FROM ContentDocumentLink WHERE LinkedEntityId IN :expenseMap.keySet()];
                for(ContentDocumentLink cdl : cdls) {
                    if(!dashboard.expenseToAttachments.containsKey(cdl.LinkedEntityId)) {
                        dashboard.expenseToAttachments.put(cdl.LinkedEntityId, new List<Id>());
                    }
                    dashboard.expenseToAttachments.get(cdl.LinkedEntityId).add(cdl.ContentDocumentId);
                }
            }

            dashboard.projects = pWrapperMap.values();
            return dashboard;

        } catch (Exception e) { throw new AuraHandledException('Failed to load Enterprise Approval Data: ' + e.getMessage()); }
    }
}