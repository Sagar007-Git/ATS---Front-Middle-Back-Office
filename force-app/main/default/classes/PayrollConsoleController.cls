public with sharing class PayrollConsoleController {

    // ==========================================
    // 1. DATA WRAPPERS
    // ==========================================
    public class ConsolidatedCandidateWrapper {
        @AuraEnabled public Id candidateId { get; set; }
        @AuraEnabled public String candidateName { get; set; }
        @AuraEnabled public Integer projectCount { get; set; }
        @AuraEnabled public Decimal totalHours { get; set; }
        @AuraEnabled public Decimal totalAmount { get; set; }
        @AuraEnabled public String totalAmountDisplay { get; set; }
        @AuraEnabled public Boolean selected { get; set; }
        @AuraEnabled public String rowClass { get; set; }
        
        private transient Set<Id> uniqueProjectIds;
        
        public ConsolidatedCandidateWrapper(Id candId, String candName) {
            this.candidateId = candId;
            this.candidateName = candName;
            this.totalHours = 0.0;
            this.totalAmount = 0.0;
            this.selected = false;
            this.rowClass = 'saas-grid-row';
            this.uniqueProjectIds = new Set<Id>();
        }

        public void addProjectId(Id projId) { if(projId != null) this.uniqueProjectIds.add(projId); }
        public void finalizeCounts() {
            this.projectCount = this.uniqueProjectIds.size();
        }
    }

    // ==========================================
    // 2. THE CONSOLIDATION ENGINE (PAYROLL)
    // ==========================================
    @AuraEnabled(cacheable=true)
    public static List<ConsolidatedCandidateWrapper> getConsolidatedPayroll(Date startDate, Date endDate) {
        Map<Id, ConsolidatedCandidateWrapper> candidateMap = new Map<Id, ConsolidatedCandidateWrapper>();

        try {
            // Fetch Time Entries for candidates with pay rate
            List<Time_Entry__c> timeEntries = [
                SELECT Id, Date__c, Hours_Worked_Number_Format__c, 
                       Contact__c, Contact__r.Name, Project__c, Project_Resource__r.Pay_Rate__c, Project_Resource__c
                FROM Time_Entry__c
                WHERE Time_Status__c = 'Approved' AND Date__c >= :startDate AND Date__c <= :endDate AND Contact__c != null
            ];

            for (Time_Entry__c te : timeEntries) {
                Id candId = te.Contact__c;
                if (!candidateMap.containsKey(candId)) {
                    candidateMap.put(candId, new ConsolidatedCandidateWrapper(candId, te.Contact__r.Name));
                }
                
                ConsolidatedCandidateWrapper wrap = candidateMap.get(candId);
                wrap.addProjectId(te.Project__c);
                
                Decimal hours = te.Hours_Worked_Number_Format__c != null ? te.Hours_Worked_Number_Format__c : 0;
                Decimal payRate = te.Project_Resource__r != null && te.Project_Resource__r.Pay_Rate__c != null ? te.Project_Resource__r.Pay_Rate__c : 0;
                
                wrap.totalHours += hours;
                wrap.totalAmount += (hours * payRate);
            }

            List<ConsolidatedCandidateWrapper> results = candidateMap.values();
            for (ConsolidatedCandidateWrapper wrap : results) {
                wrap.finalizeCounts();
                List<String> args = new String[]{'0','number','###,###,##0.00'};
                wrap.totalAmountDisplay = '$' + String.format(wrap.totalAmount.format(), args);
            }

            return results;
        } catch (Exception e) {
            throw new AuraHandledException('Error consolidating payroll: ' + e.getMessage());
        }
    }

    // ==========================================
    // 3. MASTER PAYROLL RUN (TRIGGERS BATCH)
    // ==========================================
    @AuraEnabled
    public static String executeMasterPayrollRun(List<Id> candidateIds, Date startDate, Date endDate) {
        try {
            // Validate Emails exist before firing batch
            List<Contact> candidates = [SELECT Name, Email FROM Contact WHERE Id IN :candidateIds];
            List<String> missingEmails = new List<String>();
            
            for(Contact c : candidates) {
                if(String.isBlank(c.Email)) missingEmails.add(c.Name);
            }
            
            if(!missingEmails.isEmpty()) {
                // 🌟 FIX: Use proper AuraHandledException syntax to bypass "Script-thrown exception"
                String errMsg = 'Dispatch Blocked: The following Candidates are missing an Email Address: ' + String.join(missingEmails, ', ');
                AuraHandledException e = new AuraHandledException(errMsg);
                e.setMessage(errMsg); 
                throw e;
            }

            // Fire the Batch Job
            Database.executeBatch(new PayrollDispatchBatch(candidateIds, startDate, endDate), 1);
            
            return 'Success! Payrolls are being generated and dispatched in the background.';
            
        } catch (Exception e) {
            // 🌟 FIX: Unmask any other generic exceptions
            AuraHandledException ex = new AuraHandledException(e.getMessage());
            ex.setMessage(e.getMessage());
            throw ex;
        }
    }

    // ==========================================
    // 4. HISTORY LEGAR & PAYMENTS
    // ==========================================
    public class DynamicPayrollWrapper {
        @AuraEnabled public String Id { get; set; }
        @AuraEnabled public String Name { get; set; }
        @AuraEnabled public String candidateName { get; set; }
        @AuraEnabled public Date payrollDate { get; set; }
        @AuraEnabled public String status { get; set; }
        @AuraEnabled public Decimal totalAmount { get; set; }
        @AuraEnabled public Id candidateId { get; set; }
        @AuraEnabled public Id fileId { get; set; } 
        @AuraEnabled public Datetime generatedDate { get; set; } 
    }

  @AuraEnabled(cacheable=true)
    public static List<DynamicPayrollWrapper> getTrackedPayroll() {
        Map<String, DynamicPayrollWrapper> wrapMap = new Map<String, DynamicPayrollWrapper>();
        
        List<Time_Entry__c> entries = [
            SELECT Id, Hours_Worked_Number_Format__c, Contact__c, Contact__r.Name, Project_Resource__r.Pay_Rate__c, Payroll_Status__c, Virtual_Payroll_ID__c
            FROM Time_Entry__c
            WHERE Payroll_Status__c IN ('Sent', 'Paid') AND Virtual_Payroll_ID__c != null
        ];

        for(Time_Entry__c te : entries) {
            String key = te.Virtual_Payroll_ID__c; // 🌟 Grouping by the permanent stamp!

            DynamicPayrollWrapper w = wrapMap.get(key);
            if(w == null) {
                w = new DynamicPayrollWrapper();
                w.Id = key; w.Name = key; w.candidateId = te.Contact__c; w.candidateName = te.Contact__r.Name;
                w.status = te.Payroll_Status__c; w.totalAmount = 0.0;
                wrapMap.put(key, w);
            }

            Decimal hours = te.Hours_Worked_Number_Format__c != null ? te.Hours_Worked_Number_Format__c : 0;
            Decimal rate = te.Project_Resource__r != null && te.Project_Resource__r.Pay_Rate__c != null ? te.Project_Resource__r.Pay_Rate__c : 0;
            w.totalAmount += (hours * rate);
        }

        if(!wrapMap.isEmpty()) {
            List<ContentVersion> savedPdfs = [SELECT ContentDocumentId, Description, CreatedDate FROM ContentVersion WHERE Description IN :wrapMap.keySet() AND IsLatest = true];
            for(ContentVersion cv : savedPdfs) {
                if(wrapMap.containsKey(cv.Description)) {
                    DynamicPayrollWrapper w = wrapMap.get(cv.Description);
                    w.fileId = cv.ContentDocumentId;
                    w.generatedDate = cv.CreatedDate; 
                    w.payrollDate = cv.CreatedDate.date();
                }
            }
        }
        return wrapMap.values();
    }

    @AuraEnabled
    public static String markPayrollAsPaid(String payrollKey) {
        try {
            List<Time_Entry__c> tesToUpdate = [SELECT Id, Payroll_Status__c FROM Time_Entry__c WHERE Virtual_Payroll_ID__c = :payrollKey AND Payroll_Status__c = 'Sent'];
            for(Time_Entry__c te : tesToUpdate) te.Payroll_Status__c = 'Paid';
            if(!tesToUpdate.isEmpty()) { update tesToUpdate; return 'Successfully marked payroll as Paid.'; }
            return 'No eligible records found to update.';
        } catch (Exception e) { throw new AuraHandledException(e.getMessage()); }
    }
}