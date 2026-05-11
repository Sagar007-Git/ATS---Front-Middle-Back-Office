public with sharing class InvoiceConsoleController {

    // ==========================================
    // 1. DATA WRAPPERS
    // ==========================================
    public class ConsolidatedClientWrapper {
        @AuraEnabled public Id accountId { get; set; }
        @AuraEnabled public String accountName { get; set; }
        @AuraEnabled public Integer projectCount { get; set; }
        @AuraEnabled public Integer candidateCount { get; set; }
        @AuraEnabled public Decimal totalHours { get; set; }
        @AuraEnabled public Decimal totalAmount { get; set; }
        @AuraEnabled public String totalAmountDisplay { get; set; }
        @AuraEnabled public Boolean selected { get; set; }
        @AuraEnabled public String rowClass { get; set; }
        
        private transient Set<Id> uniqueProjectIds;
        private transient Set<Id> uniqueCandidateIds;
        
        public ConsolidatedClientWrapper(Id accId, String accName) {
            this.accountId = accId;
            this.accountName = accName;
            this.totalHours = 0.0;
            this.totalAmount = 0.0;
            this.selected = false;
            this.rowClass = 'saas-grid-row';
            this.uniqueProjectIds = new Set<Id>();
            this.uniqueCandidateIds = new Set<Id>();
        }

        public void addProjectId(Id projId) { if(projId != null) this.uniqueProjectIds.add(projId); }
        public void addCandidateId(Id candId) { if(candId != null) this.uniqueCandidateIds.add(candId); }
        public void finalizeCounts() {
            this.projectCount = this.uniqueProjectIds.size();
            this.candidateCount = this.uniqueCandidateIds.size();
        }
    }

    // ==========================================
    // 2. THE CONSOLIDATION ENGINE
    // ==========================================
    @AuraEnabled(cacheable=true)
    public static List<ConsolidatedClientWrapper> getConsolidatedBilling(Date startDate, Date endDate) {
        Map<Id, ConsolidatedClientWrapper> clientMap = new Map<Id, ConsolidatedClientWrapper>();

        try {
            List<Time_Entry__c> timeEntries = [
                SELECT Id, Date__c, Hours_Worked_Number_Format__c, 
                       Contact__c, Project__c, Project__r.Client__c, Project__r.Client__r.Name,
                       Project__r.Bill_Rate__c, Task__r.Bill_Rate__c
                FROM Time_Entry__c
                WHERE Time_Status__c = 'Approved' AND Date__c >= :startDate AND Date__c <= :endDate AND Project__r.Client__c != null
            ];

            for (Time_Entry__c te : timeEntries) {
                Id accId = te.Project__r.Client__c;
                if (!clientMap.containsKey(accId)) clientMap.put(accId, new ConsolidatedClientWrapper(accId, te.Project__r.Client__r.Name));
                
                ConsolidatedClientWrapper wrap = clientMap.get(accId);
                wrap.addProjectId(te.Project__c);
                wrap.addCandidateId(te.Contact__c);
                
                Decimal hours = te.Hours_Worked_Number_Format__c != null ? te.Hours_Worked_Number_Format__c : 0;
                Decimal billRate = te.Task__r != null && te.Task__r.Bill_Rate__c != null ? te.Task__r.Bill_Rate__c : (te.Project__r.Bill_Rate__c != null ? te.Project__r.Bill_Rate__c : 0);
                
                wrap.totalHours += hours;
                wrap.totalAmount += (hours * billRate);
            }

            List<Expense__c> expenses = [
                SELECT Id, Expense_Date__c, Amount__c, 
                       Contact__c, Project__c, Project__r.Client__c, Project__r.Client__r.Name
                FROM Expense__c
                WHERE Status__c = 'Approved' AND Expense_Date__c >= :startDate AND Expense_Date__c <= :endDate AND Project__r.Client__c != null
            ];

            for (Expense__c exp : expenses) {
                Id accId = exp.Project__r.Client__c;
                if (!clientMap.containsKey(accId)) clientMap.put(accId, new ConsolidatedClientWrapper(accId, exp.Project__r.Client__r.Name));
                
                ConsolidatedClientWrapper wrap = clientMap.get(accId);
                wrap.addProjectId(exp.Project__c);
                wrap.addCandidateId(exp.Contact__c);
                
                Decimal amt = exp.Amount__c != null ? exp.Amount__c : 0;
                wrap.totalAmount += amt;
            }

            List<ConsolidatedClientWrapper> results = clientMap.values();
            for (ConsolidatedClientWrapper wrap : results) {
                wrap.finalizeCounts();
                List<String> args = new String[]{'0','number','###,###,##0.00'};
                wrap.totalAmountDisplay = '$' + String.format(wrap.totalAmount.format(), args);
            }

            return results;
        } catch (Exception e) {
            throw new AuraHandledException('Error consolidating billing: ' + e.getMessage());
        }
    }

    // ==========================================
    // 3. MASTER BILLING RUN (TRIGGERS BATCH)
    // ==========================================
    @AuraEnabled
    public static String executeMasterBillingRun(List<Id> accountIds, Date startDate, Date endDate) {
        try {
            // Validate Emails exist before firing batch
            List<Account> accounts = [SELECT Name, Billing_Email__c FROM Account WHERE Id IN :accountIds];
            List<String> missingEmails = new List<String>();
            
            for(Account a : accounts) {
                if(String.isBlank(a.Billing_Email__c)) missingEmails.add(a.Name);
            }
            
            if(!missingEmails.isEmpty()) {
                // 🌟 FIX: Use proper AuraHandledException syntax
                String errMsg = 'Dispatch Blocked: The following Clients are missing a Billing Email: ' + String.join(missingEmails, ', ');
                AuraHandledException e = new AuraHandledException(errMsg);
                e.setMessage(errMsg); 
                throw e;
            }

            // Fire the Batch Job
            Database.executeBatch(new InvoiceDispatchBatch(accountIds, startDate, endDate), 1);
            
            return 'Success! Invoices are being generated and dispatched in the background.';
            
        } catch (Exception e) {
            // 🌟 FIX: Unmask any other generic exceptions
            AuraHandledException ex = new AuraHandledException(e.getMessage());
            ex.setMessage(e.getMessage());
            throw ex;
        }
    }

    // ==========================================
    // 4. HISTORY LEDGER & PAYMENTS
    // ==========================================
    public class DynamicInvoiceWrapper {
        @AuraEnabled public String Id { get; set; }
        @AuraEnabled public String Name { get; set; }
        @AuraEnabled public String clientName { get; set; }
        @AuraEnabled public Date invoiceDate { get; set; }
        @AuraEnabled public Date dueDate { get; set; }
        @AuraEnabled public String status { get; set; }
        @AuraEnabled public Decimal totalCharges { get; set; }
        @AuraEnabled public Decimal invoiceBalance { get; set; }
        @AuraEnabled public Id accountId { get; set; }
        @AuraEnabled public Id fileId { get; set; } 
        @AuraEnabled public Datetime generatedDate { get; set; } 
    }

   @AuraEnabled(cacheable=true)
    public static List<DynamicInvoiceWrapper> getTrackedInvoices() {
        Map<String, DynamicInvoiceWrapper> wrapMap = new Map<String, DynamicInvoiceWrapper>();
        
        List<Time_Entry__c> entries = [
            SELECT Id, Date__c, Hours_Worked_Number_Format__c, 
                   Project__r.Client__c, Project__r.Client__r.Name, 
                   Project__r.Bill_Rate__c, Task__r.Bill_Rate__c, Invoice_Status__c, Virtual_Invoice_ID__c
            FROM Time_Entry__c
            WHERE Invoice_Status__c IN ('Sent', 'Paid', 'Overdue') AND Virtual_Invoice_ID__c != null
        ];

        for(Time_Entry__c te : entries) {
            String key = te.Virtual_Invoice_ID__c; // 🌟 Grouping by the permanent stamp!

            DynamicInvoiceWrapper w = wrapMap.get(key);
            if(w == null) {
                w = new DynamicInvoiceWrapper();
                w.Id = key; w.Name = key; w.accountId = te.Project__r.Client__c; w.clientName = te.Project__r.Client__r.Name;
                w.status = te.Invoice_Status__c; w.totalCharges = 0.0; w.invoiceBalance = 0.0;
                wrapMap.put(key, w);
            }

            Decimal hours = te.Hours_Worked_Number_Format__c != null ? te.Hours_Worked_Number_Format__c : 0;
            Decimal rate = te.Task__r != null && te.Task__r.Bill_Rate__c != null ? te.Task__r.Bill_Rate__c : (te.Project__r.Bill_Rate__c != null ? te.Project__r.Bill_Rate__c : 0);
            Decimal amt = hours * rate;

            w.totalCharges += amt;
            if(w.status != 'Paid') w.invoiceBalance += amt;
        }

        List<Expense__c> expenses = [
            SELECT Id, Amount__c, Status__c, Virtual_Invoice_ID__c
            FROM Expense__c
            WHERE Status__c IN ('Sent', 'Paid', 'Overdue') AND Virtual_Invoice_ID__c != null
        ];

        for(Expense__c exp : expenses) {
            if(wrapMap.containsKey(exp.Virtual_Invoice_ID__c)) {
                DynamicInvoiceWrapper w = wrapMap.get(exp.Virtual_Invoice_ID__c);
                Decimal amt = exp.Amount__c != null ? exp.Amount__c : 0;
                w.totalCharges += amt;
                if(exp.Status__c != 'Paid') w.invoiceBalance += amt;
            }
        }

        if(!wrapMap.isEmpty()) {
            List<ContentVersion> savedPdfs = [SELECT ContentDocumentId, Description, CreatedDate FROM ContentVersion WHERE Description IN :wrapMap.keySet() AND IsLatest = true];
            for(ContentVersion cv : savedPdfs) {
                if(wrapMap.containsKey(cv.Description)) {
                    DynamicInvoiceWrapper w = wrapMap.get(cv.Description);
                    w.fileId = cv.ContentDocumentId;
                    w.generatedDate = cv.CreatedDate;
                    w.invoiceDate = cv.CreatedDate.date();
                    w.dueDate = cv.CreatedDate.date().addDays(30);
                }
            }
        }
        return wrapMap.values();
    }

    @AuraEnabled
    public static String markInvoiceAsPaid(String invoiceKey) {
        try {
            // 🌟 Simplest update ever! The invoiceKey is now exactly the ID stamp.
            List<Time_Entry__c> tesToUpdate = [SELECT Id, Invoice_Status__c FROM Time_Entry__c WHERE Virtual_Invoice_ID__c = :invoiceKey AND (Invoice_Status__c = 'Sent' OR Invoice_Status__c = 'Overdue')];
            for(Time_Entry__c te : tesToUpdate) te.Invoice_Status__c = 'Paid';
            if(!tesToUpdate.isEmpty()) update tesToUpdate; 

            List<Expense__c> expsToUpdate = [SELECT Id, Status__c FROM Expense__c WHERE Virtual_Invoice_ID__c = :invoiceKey AND (Status__c = 'Sent' OR Status__c = 'Overdue')];
            for(Expense__c exp : expsToUpdate) exp.Status__c = 'Paid';
            if(!expsToUpdate.isEmpty()) update expsToUpdate;

            return 'Successfully marked invoice as Paid. Balance is now $0.00.'; 
        } catch (Exception e) { throw new AuraHandledException(e.getMessage()); }
    }
}