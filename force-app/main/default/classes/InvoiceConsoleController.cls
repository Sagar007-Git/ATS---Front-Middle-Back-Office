public with sharing class InvoiceConsoleController {

    // ==========================================
    // 1. DATA WRAPPERS
    // ==========================================
    public class InvoiceDataWrapper {
        @AuraEnabled public Id projectId { get; set; }       
        @AuraEnabled public String projectName { get; set; } 
        @AuraEnabled public Id accountId { get; set; }
        @AuraEnabled public String accountName { get; set; }
        @AuraEnabled public String candidateName { get; set; } // ✅ Required for "By Candidate" tab
        
        @AuraEnabled public Integer unbilledTimeEntries { get; set; }
        @AuraEnabled public Decimal totalHours { get; set; }
        @AuraEnabled public Decimal totalExpenses { get; set; } 
    }

    public class EntitySummaryWrapper {
        @AuraEnabled public Id entityId { get; set; }
        @AuraEnabled public String entityName { get; set; }
        @AuraEnabled public String entityType { get; set; }
        @AuraEnabled public String status { get; set; }
    }

    // Used internally to bucket Time Entries during Invoice Generation
    private class ResourceLineBucket {
        Invoice_Line__c invLine;
        List<Time_Entry__c> entries;
        
        public ResourceLineBucket(Id invoiceId, Id resourceId, String resourceName, Decimal rate) {
            this.invLine = new Invoice_Line__c(
                Pxm_Invoice__c = invoiceId,
                Project_Resource__c = resourceId,
                Name = ('Consulting: ' + resourceName).left(80),
                Line_Description__c = 'Aggregated consulting hours for ' + resourceName,
                Bill_Rate__c = rate,
                Hours__c = 0
            );
            this.entries = new List<Time_Entry__c>();
        }
    }

    // ==========================================
    // 2. METADATA HELPERS
    // ==========================================
    private static String getTargetStatus() {
        Invoice_Setting__mdt setting = Invoice_Setting__mdt.getInstance('Default');
        return (setting != null && String.isNotBlank(setting.Target_Status__c)) ? setting.Target_Status__c : 'Approved';
    }

    private static String getInvoicedStatus() {
        Invoice_Setting__mdt setting = Invoice_Setting__mdt.getInstance('Default');
        return (setting != null && String.isNotBlank(setting.Invoiced_Status__c)) ? setting.Invoiced_Status__c : 'Invoiced';
    }

    private static Integer getDueDateOffset() {
        Invoice_Setting__mdt setting = Invoice_Setting__mdt.getInstance('Default');
        return (setting != null && setting.Default_Due_Date_Offset__c != null) ? Integer.valueOf(String.valueOf(setting.Default_Due_Date_Offset__c)) : 30;
    }

    // ==========================================
    // 3. THE SWEEP: READ UNBILLED PROJECTS
    // ==========================================
    @AuraEnabled(cacheable=true)
    public static List<InvoiceDataWrapper> getUnbilledProjects() {
        try {
            String targetStatus = getTargetStatus(); 
            // ✅ Composite Map Key (Project + Candidate) prevents multiple candidates on one project from overwriting each other
            Map<String, InvoiceDataWrapper> recordMap = new Map<String, InvoiceDataWrapper>();

            // 1. Sweep Aggregate Time Entries 
            for (AggregateResult ar : [
                SELECT Project__c projId, Project__r.Name projName, 
                       Project__r.Client__c accId, Project__r.Client__r.Name accName, 
                       Project_Resource__r.Candidate_Employee__r.Name candName, // ✅ Query Candidate
                       COUNT(Id) entryCount, SUM(Hours_Worked_Number_Format__c) totalHours
                FROM Time_Entry__c
                WHERE Approval_Status__c = :targetStatus AND Pxm_Invoice_Line__c = null
                GROUP BY Project__c, Project__r.Name, Project__r.Client__c, Project__r.Client__r.Name, Project_Resource__r.Candidate_Employee__r.Name
            ]) {
                Id pId = (Id)ar.get('projId');
                String candName = (String)ar.get('candName');
                if (String.isBlank(candName)) candName = 'Unknown Resource';
                
                String compositeKey = pId + '_' + candName;

                InvoiceDataWrapper wrap = new InvoiceDataWrapper();
                wrap.projectId = pId;
                wrap.projectName = (String)ar.get('projName');
                wrap.accountId = (Id)ar.get('accId');
                wrap.accountName = (String)ar.get('accName');
                wrap.candidateName = candName;
                wrap.unbilledTimeEntries = (Integer)ar.get('entryCount');
                wrap.totalHours = (Decimal)ar.get('totalHours');
                wrap.totalExpenses = 0.0;
                
                recordMap.put(compositeKey, wrap);
            }

            // 2. Sweep Aggregate Expenses
            for (AggregateResult ar : [
                SELECT Project__c projId, Project__r.Name projName, 
                       Project__r.Client__c accId, Project__r.Client__r.Name accName, 
                       SUM(Amount__c) totalExp
                FROM Expense__c
                WHERE Status__c = :targetStatus AND Pxm_Invoice_Line__c = null
                GROUP BY Project__c, Project__r.Name, Project__r.Client__c, Project__r.Client__r.Name
            ]) {
                Id pId = (Id)ar.get('projId');
                String candName = 'Project Expenses'; // Expenses usually apply to the whole project
                String compositeKey = pId + '_' + candName;

                if (!recordMap.containsKey(compositeKey)) {
                    InvoiceDataWrapper wrap = new InvoiceDataWrapper();
                    wrap.projectId = pId;
                    wrap.projectName = (String)ar.get('projName');
                    wrap.accountId = (Id)ar.get('accId');
                    wrap.accountName = (String)ar.get('accName');
                    wrap.candidateName = candName;
                    wrap.unbilledTimeEntries = 0;
                    wrap.totalHours = 0.0;
                    wrap.totalExpenses = (Decimal)ar.get('totalExp');
                    recordMap.put(compositeKey, wrap);
                } else {
                    recordMap.get(compositeKey).totalExpenses += (Decimal)ar.get('totalExp');
                }
            }

            return recordMap.values();

        } catch (Exception e) {
            throw createAuraException('Failed to fetch unbilled projects: ' + e.getMessage());
        }
    }

    // ==========================================
    // 4. GENERATE INVOICES (The Aggregation Engine)
    // ==========================================
    @AuraEnabled
    public static String generateInvoices(List<Id> projectIds) {
        if (projectIds == null || projectIds.isEmpty()) {
            throw createAuraException('No Projects provided for invoice generation.');
        }

        Savepoint sp = Database.setSavepoint();

        try {
            String targetStatus = getTargetStatus();
            String invoicedStatus = getInvoicedStatus();
            Integer dueOffset = getDueDateOffset();

            // --- STEP 1: QUERY RAW DATA (THE SWEEP) ---
            List<Time_Entry__c> timeEntriesToBill = [
                SELECT Id, Hours_Worked_Number_Format__c, Date__c, Additional_Comments__c,
                       Project__c, Project__r.Client__c, Project__r.Name, 
                       Project_Resource__c, Project_Resource__r.Candidate_Employee__r.Name,
                       Project_Resource__r.Bill_Rate__c, Project_Resource__r.Placement__r.Bill_Rate__c,
                       Task__c, Task__r.Name, Task__r.Bill_Rate__c
                FROM Time_Entry__c
                WHERE Project__c IN :projectIds AND Approval_Status__c = :targetStatus AND Pxm_Invoice_Line__c = null
                FOR UPDATE
            ];

            List<Expense__c> expensesToBill = [
                SELECT Id, Amount__c, Project__c, Project__r.Client__c, Project__r.Name, Description__c 
                FROM Expense__c
                WHERE Project__c IN :projectIds AND Status__c = :targetStatus AND Pxm_Invoice_Line__c = null
                FOR UPDATE
            ];

            if (timeEntriesToBill.isEmpty() && expensesToBill.isEmpty()) {
                throw new CustomException('No Approved Time Entries or Expenses found for the selected Projects.');
            }

            // --- STEP 2: CREATE INVOICE HEADERS ---
            Map<Id, Invoice__c> projectToInvoiceMap = new Map<Id, Invoice__c>();
            
            Set<Id> activeProjectIds = new Set<Id>();
            Map<Id, Id> projectToAccountMap = new Map<Id, Id>();
            Map<Id, String> projectNames = new Map<Id, String>();

            for (Time_Entry__c te : timeEntriesToBill) {
                activeProjectIds.add(te.Project__c);
                projectToAccountMap.put(te.Project__c, te.Project__r.Client__c);
                projectNames.put(te.Project__c, te.Project__r.Name);
            }
            for (Expense__c exp : expensesToBill) {
                activeProjectIds.add(exp.Project__c);
                projectToAccountMap.put(exp.Project__c, exp.Project__r.Client__c);
                projectNames.put(exp.Project__c, exp.Project__r.Name);
            }

            for (Id pId : activeProjectIds) {
                Id accId = projectToAccountMap.get(pId);
                
                if (accId == null) {
                    throw new CustomException('Cannot generate invoice for project "' + projectNames.get(pId) + '" because it is not linked to a Client Account. Please update the Project and try again.');
                }

                Invoice__c newInvoice = new Invoice__c(
                    Project__c = pId,
                    Account__c = accId,
                    Invoice_Date__c = Date.today(),
                    Due_Date__c = Date.today().addDays(dueOffset),
                    Status__c = 'Draft'
                );
                projectToInvoiceMap.put(pId, newInvoice);
            }
            insert projectToInvoiceMap.values();

            // --- STEP 3: AGGREGATE TIME INTO INVOICE LINES ---
            Map<String, ResourceLineBucket> lineBuckets = new Map<String, ResourceLineBucket>();

            for (Time_Entry__c te : timeEntriesToBill) {
                // --- RATE WATERFALL CALCULATION ---
                Decimal resourceRate = 0.0;
                if (te.Project_Resource__r != null && te.Project_Resource__r.Bill_Rate__c != null) {
                    try {
                        resourceRate = Decimal.valueOf(String.valueOf(te.Project_Resource__r.Bill_Rate__c));
                    } catch(Exception e) { resourceRate = 0.0; }
                }
                
                Decimal placementRate = 0.0;
                if (te.Project_Resource__r != null && te.Project_Resource__r.Placement__r != null && te.Project_Resource__r.Placement__r.Bill_Rate__c != null) {
                    try {
                        placementRate = Decimal.valueOf(String.valueOf(te.Project_Resource__r.Placement__r.Bill_Rate__c));
                    } catch(Exception e) { placementRate = 0.0; }
                }
                
                Decimal baseRate = (resourceRate > 0) ? resourceRate : placementRate;
                
                Decimal dailyRate = baseRate;
                if (te.Task__r != null && te.Task__r.Bill_Rate__c != null) {
                    try {
                        dailyRate = Decimal.valueOf(String.valueOf(te.Task__r.Bill_Rate__c));
                    } catch(Exception e) { dailyRate = baseRate; }
                }

                // Grouping Key: Project + Resource + Rate 
                String bucketKey = te.Project__c + '_' + te.Project_Resource__c + '_' + dailyRate;

                if (!lineBuckets.containsKey(bucketKey)) {
                    Id parentInvId = projectToInvoiceMap.get(te.Project__c).Id;
                    
                    String candName = 'Unknown Resource';
                    if (te.Project_Resource__r != null && te.Project_Resource__r.Candidate_Employee__r != null && String.isNotBlank(te.Project_Resource__r.Candidate_Employee__r.Name)) {
                        candName = te.Project_Resource__r.Candidate_Employee__r.Name;
                    }
                    
                    lineBuckets.put(bucketKey, new ResourceLineBucket(parentInvId, te.Project_Resource__c, candName, dailyRate));
                }

                ResourceLineBucket bucket = lineBuckets.get(bucketKey);
                bucket.entries.add(te);
                bucket.invLine.Hours__c += (te.Hours_Worked_Number_Format__c != null) ? te.Hours_Worked_Number_Format__c : 0.0;
            }

            // --- STEP 4: AGGREGATE EXPENSES INTO INVOICE LINES ---
            Map<Id, Invoice_Line__c> projectExpenseLines = new Map<Id, Invoice_Line__c>();
            
            for (Expense__c exp : expensesToBill) {
                if (!projectExpenseLines.containsKey(exp.Project__c)) {
                    projectExpenseLines.put(exp.Project__c, new Invoice_Line__c(
                        Pxm_Invoice__c = projectToInvoiceMap.get(exp.Project__c).Id,
                        Name = 'Reimbursable Expenses',
                        Hours__c = 1,
                        Bill_Rate__c = 0 
                    ));
                }
                projectExpenseLines.get(exp.Project__c).Bill_Rate__c += (exp.Amount__c != null) ? exp.Amount__c : 0.0;
            }

            // Insert All Lines
            List<Invoice_Line__c> allLinesToInsert = new List<Invoice_Line__c>();
            for (ResourceLineBucket bucket : lineBuckets.values()) {
                allLinesToInsert.add(bucket.invLine);
            }
            allLinesToInsert.addAll(projectExpenseLines.values());
            
            if (!allLinesToInsert.isEmpty()) {
                insert allLinesToInsert;
            }

            // --- STEP 5: THE LOCK (Stamp Lines onto Source Records) ---
            List<Time_Entry__c> timeEntriesToUpdate = new List<Time_Entry__c>();
            for (ResourceLineBucket bucket : lineBuckets.values()) {
                for (Time_Entry__c te : bucket.entries) {
                    te.Pxm_Invoice_Line__c = bucket.invLine.Id;
                    te.Invoice_Status__c = invoicedStatus; // Marks it as Billed
                    timeEntriesToUpdate.add(te);
                }
            }

            List<Expense__c> expensesToUpdate = new List<Expense__c>();
            for (Expense__c exp : expensesToBill) {
                exp.Pxm_Invoice_Line__c = projectExpenseLines.get(exp.Project__c).Id;
                exp.Status__c = invoicedStatus; // Marks it as Billed
                expensesToUpdate.add(exp);
            }

            if (!timeEntriesToUpdate.isEmpty()) update timeEntriesToUpdate;
            if (!expensesToUpdate.isEmpty()) update expensesToUpdate;

            return 'Success: Generated ' + projectToInvoiceMap.size() + ' invoice(s).';

        } catch (Exception e) {
            Database.rollback(sp);
            throw createAuraException('Generation failed: ' + e.getMessage() + ' at line ' + e.getLineNumber());
        }
    }

    // ==========================================
    // 5. INVOICE DISPATCH HUB: DRAFTS & EMAIL
    // ==========================================
    @AuraEnabled(cacheable=true)
    public static List<Invoice__c> getDraftInvoices() {
        try {
            return [
                SELECT Id, Name, Account__c, Account__r.Name, Account__r.Billing_Email__c,
                       Project__r.Name, Invoice_Date__c, Due_Date__c, Status__c 
                FROM Invoice__c
                WHERE Status__c = 'Draft'
                ORDER BY Invoice_Date__c ASC
                LIMIT 500
            ];
        } catch (Exception e) {
            throw createAuraException('Error fetching draft invoices: ' + e.getMessage());
        }
    }

    @AuraEnabled
    public static String dispatchInvoices(List<Id> invoiceIds) {
        if (invoiceIds == null || invoiceIds.isEmpty()) {
            throw createAuraException('No invoices selected.');
        }
        try {
            System.enqueueJob(new InvoiceDispatchQueueable(invoiceIds));
            return 'Dispatch initiated! ' + invoiceIds.size() + ' invoices are being generated and emailed in the background.';
        } catch (Exception e) {
            throw createAuraException('Failed to start dispatch: ' + e.getMessage());
        }
    }

    // ==========================================
    // 6. DIRECTORY TRANSACTIONS (Entity Fetching)
    // ==========================================
    @AuraEnabled(cacheable=true)
    public static List<EntitySummaryWrapper> getActiveEntities(String entityType) {
        List<EntitySummaryWrapper> results = new List<EntitySummaryWrapper>();
        try {
            if (entityType == 'Account') {
                for (Account acc : [SELECT Id, Name FROM Account ORDER BY Name LIMIT 100]) {
                    results.add(createEntityWrapper(acc.Id, acc.Name, 'Account', 'Active Client'));
                }
            } else if (entityType == 'Project') {
                String query = 'SELECT Id, Name FROM Project__c ORDER BY Name LIMIT 100';
                for (SObject proj : Database.query(query)) {
                    results.add(createEntityWrapper((Id)proj.get('Id'), (String)proj.get('Name'), 'Project', 'Active Project'));
                }
            } else if (entityType == 'Candidate') {
                for (Contact con : [SELECT Id, Name FROM Contact ORDER BY Name LIMIT 100]) {
                    results.add(createEntityWrapper(con.Id, con.Name, 'Candidate', 'Active Resource'));
                }
            } else if (entityType == 'Task') {
                String query = 'SELECT Id, Name FROM Task__c ORDER BY Name LIMIT 100';
                for (SObject tsk : Database.query(query)) {
                    results.add(createEntityWrapper((Id)tsk.get('Id'), (String)tsk.get('Name'), 'Task', 'Active Task'));
                }
            }
            return results;
        } catch (Exception e) {
            return results; 
        }
    }

    @AuraEnabled(cacheable=true)
    public static List<Invoice__c> getTrackedInvoices() {
        try {
            return [
                SELECT Id, Name, Account__c, Account__r.Name, Account__r.Billing_Email__c,
                       Project__r.Name, Invoice_Date__c, Due_Date__c, Status__c 
                FROM Invoice__c
                WHERE Status__c != 'Draft' 
                ORDER BY CreatedDate DESC
                LIMIT 1000
            ];
        } catch (Exception e) {
            throw createAuraException('Error fetching tracked invoices: ' + e.getMessage());
        }
    }

    private static EntitySummaryWrapper createEntityWrapper(Id recId, String recName, String recType, String status) {
        EntitySummaryWrapper wrap = new EntitySummaryWrapper();
        wrap.entityId = recId;
        wrap.entityName = recName;
        wrap.entityType = recType;
        wrap.status = status;
        return wrap;
    }

    // ==========================================
    // 7. EXCEPTION HANDLING UTILITIES
    // ==========================================
    public class CustomException extends Exception {}

    private static AuraHandledException createAuraException(String message) {
        AuraHandledException e = new AuraHandledException(message);
        e.setMessage(message); 
        return e;
    }
}