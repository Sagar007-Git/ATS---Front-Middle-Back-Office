public with sharing class InvoiceConsoleController {

    // ==========================================
    // 1. DATA WRAPPER
    // ==========================================
    public class InvoiceDataWrapper {
        @AuraEnabled public Id timesheetId { get; set; }
        @AuraEnabled public String timesheetName { get; set; }
        @AuraEnabled public String accountName { get; set; }
        @AuraEnabled public Id accountId { get; set; }
        @AuraEnabled public String projectName { get; set; } 
        @AuraEnabled public Id projectId { get; set; }       
        @AuraEnabled public String taskName { get; set; }  
        @AuraEnabled public Id taskId { get; set; }        
        @AuraEnabled public String candidateName { get; set; }
        @AuraEnabled public String reportingWeek { get; set; }
        @AuraEnabled public Decimal totalHours { get; set; }
        @AuraEnabled public Decimal totalExpenses { get; set; } 
        @AuraEnabled public Boolean hasAttachments { get; set; }
    }

    // ==========================================
    // 2. METADATA ENGINE (Safe Fetching)
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
    // 3. READ TRANSACTIONS (Data Fetching)
    // ==========================================
    @AuraEnabled(cacheable=true)
    public static List<InvoiceDataWrapper> getBillableTimesheets() {
        try {
            String targetStatus = getTargetStatus();

            // SOQL: Added Task__r.Account__c, Client__c, and Client__r.Name for Account Waterfall
            List<Timesheet__c> timesheets = [
                SELECT Id, Name, Start_Date__c, End_Date__c, Reporting_Week__c, Total_Hours__c,
                   Task__c, Task__r.Name, Task__r.Account__c, 
                   Client__c, Client__r.Name,
                   Project_Resource__r.Project__c, 
                   Project_Resource__r.Project__r.Name,
                   Project_Resource__r.Account__c, 
                   Project_Resource__r.Account__r.Name,
                   Project_Resource__r.Candidate_Employee__r.Name,
                   (SELECT Id FROM ContentDocumentLinks LIMIT 1),
                   (SELECT Amount__c FROM Expenses__r WHERE Status__c = 'Approved')
                FROM Timesheet__c
                WHERE Timesheet_Status__c = :targetStatus
                ORDER BY Project_Resource__r.Account__r.Name ASC
                LIMIT 1000
            ];

            List<InvoiceDataWrapper> wrappers = new List<InvoiceDataWrapper>();
            for (Timesheet__c ts : timesheets) {
                InvoiceDataWrapper wrapper = new InvoiceDataWrapper();
                wrapper.timesheetId = ts.Id;
                wrapper.timesheetName = ts.Name;
                
                // Task Hierarchy Mapping
                wrapper.taskId = ts.Task__c;
                wrapper.taskName = ts.Task__r?.Name;
                wrapper.projectId = ts.Project_Resource__r?.Project__c;
                wrapper.projectName = ts.Project_Resource__r?.Project__r?.Name;
                
                // ACCOUNT WATERFALL LOGIC for UI Display
                if (ts.Task__r?.Account__c != null) {
                    wrapper.accountId = ts.Task__r.Account__c;
                    wrapper.accountName = 'Task Account'; // Or query Task__r.Account__r.Name if available
                } else if (ts.Client__c != null) {
                    wrapper.accountId = ts.Client__c;
                    wrapper.accountName = ts.Client__r?.Name;
                } else {
                    wrapper.accountId = ts.Project_Resource__r?.Account__c;
                    wrapper.accountName = ts.Project_Resource__r?.Account__r?.Name;
                }

                wrapper.candidateName = ts.Project_Resource__r?.Candidate_Employee__r?.Name;
                wrapper.reportingWeek = ts.Reporting_Week__c;
                wrapper.hasAttachments = (ts.ContentDocumentLinks != null && !ts.ContentDocumentLinks.isEmpty()); 
                
                // Safe Decimal Cast for Hours
                wrapper.totalHours = (ts.Total_Hours__c != null) ? Decimal.valueOf(String.valueOf(ts.Total_Hours__c)) : 0.0;
                
                // Aggregate Expenses
                Decimal expSum = 0.0;
                if (ts.Expenses__r != null) {
                    for (Expense__c exp : ts.Expenses__r) {
                        expSum += (exp.Amount__c != null) ? Decimal.valueOf(String.valueOf(exp.Amount__c)) : 0.0;
                    }
                }
                wrapper.totalExpenses = expSum;
                
                wrappers.add(wrapper);
            }
            return wrappers;

        } catch (Exception e) {
            throw createAuraException('Failed to fetch billable records: ' + e.getMessage());
        }
    }

    // ==========================================
    // 4. WRITE TRANSACTIONS (Generating Invoices)
    // ==========================================
    @AuraEnabled
    public static String generateInvoices(List<Id> timesheetIds) {
        if (timesheetIds == null || timesheetIds.isEmpty()) {
            throw createAuraException('No Timesheets provided for invoice generation.');
        }

        Savepoint sp = Database.setSavepoint();

        try {
            String invoicedStatus = getInvoicedStatus();
            Integer dueOffset = getDueDateOffset();
            
            // SOQL: Included Client__c and Task__r.Account__c for the Waterfall
            List<Timesheet__c> timesheetsToBill = [
                SELECT Id, Name, Start_Date__c, End_Date__c, Total_Hours__c, Timesheet_Status__c, Reporting_Week__c,
                       Task__c, Task__r.Name, Task__r.Bill_Rate__c, Task__r.Account__c,
                       Client__c,
                       Project_Resource__r.Placement__r.Bill_Rate__c,
                       Project_Resource__r.Candidate_Employee__r.Name,
                       (SELECT Amount__c FROM Expenses__r WHERE Status__c = 'Approved')
                FROM Timesheet__c
                WHERE Id IN :timesheetIds
                FOR UPDATE 
            ];

            // Group by Account ID (Using the Waterfall)
            Map<Id, List<Timesheet__c>> accountToTimesheetsMap = new Map<Id, List<Timesheet__c>>();
            for (Timesheet__c ts : timesheetsToBill) {
                if (ts.Timesheet_Status__c == invoicedStatus) {
                    throw new CustomException('Timesheet ' + ts.Name + ' has already been invoiced.');
                }
                
                // THE ACCOUNT WATERFALL: Task > Timesheet Client
                Id accId = (ts.Task__r?.Account__c != null) ? ts.Task__r.Account__c : ts.Client__c;
                
                if (accId == null) {
                    throw new CustomException('Timesheet ' + ts.Name + ' is missing a billing Account (Check Task Account or Timesheet Client).');
                }

                if (!accountToTimesheetsMap.containsKey(accId)) {
                    accountToTimesheetsMap.put(accId, new List<Timesheet__c>());
                }
                accountToTimesheetsMap.get(accId).add(ts);
            }

            // Create Invoice Headers (UPDATED API NAMES)
            List<Invoice__c> invoicesToInsert = new List<Invoice__c>();
            Map<Id, Invoice__c> accountToInvoiceMap = new Map<Id, Invoice__c>();
            
            for (Id accId : accountToTimesheetsMap.keySet()) {
                Invoice__c newInvoice = new Invoice__c(
                    Account__c = accId,
                    Invoice_Date__c = Date.today(),
                    Due_Date__c = Date.today().addDays(dueOffset)
                    // Status omitted entirely so Salesforce uses the default picklist value (Draft)
                );
                invoicesToInsert.add(newInvoice);
                accountToInvoiceMap.put(accId, newInvoice); 
            }
            insert invoicesToInsert;

            // Create Invoice Lines & Update Timesheets (UPDATED API NAMES)
            List<Invoice_Line__c> linesToInsert = new List<Invoice_Line__c>();
            List<Timesheet__c> timesheetsToUpdate = new List<Timesheet__c>();

            for (Id accId : accountToTimesheetsMap.keySet()) {
                Invoice__c parentInvoice = accountToInvoiceMap.get(accId);
                
                for (Timesheet__c ts : accountToTimesheetsMap.get(accId)) {
                    
                    // --- RATE CALCULATION (Safe String-to-Decimal Casting) ---
                    Decimal safeRate = 0.0;
                    if (ts.Task__r?.Bill_Rate__c != null) {
                        safeRate = Decimal.valueOf(String.valueOf(ts.Task__r.Bill_Rate__c));
                    } else if (ts.Project_Resource__r?.Placement__r?.Bill_Rate__c != null) {
                        safeRate = Decimal.valueOf(String.valueOf(ts.Project_Resource__r.Placement__r.Bill_Rate__c));
                    }
                    
                    Decimal hours = (ts.Total_Hours__c != null) ? Decimal.valueOf(String.valueOf(ts.Total_Hours__c)) : 0.0;
                    String taskName = (String.isNotBlank(ts.Task__r?.Name)) ? ts.Task__r.Name : 'General Labor';
                    String candidateName = (String.isNotBlank(ts.Project_Resource__r?.Candidate_Employee__r?.Name)) ? ts.Project_Resource__r.Candidate_Employee__r.Name : 'Unknown Resource';

                    // --- 1. GENERATE LABOR LINE (UPDATED API NAMES) ---
                    if (hours > 0) {
                        linesToInsert.add(new Invoice_Line__c(
                            Pxm_Invoice__c = parentInvoice.Id,
                            Timesheet__c = ts.Id,
                            Hours__c = hours,      
                            Bill_Rate__c = safeRate,        
                            Name = taskName.left(80), 
                            Line_Description__c = ('Candidate: ' + candidateName + ' | Week: ' + ts.Reporting_Week__c).left(255)
                        ));
                    }

                    // --- 2. GENERATE EXPENSE LINE (UPDATED API NAMES) ---
                    Decimal expSum = 0.0;
                    if (ts.Expenses__r != null) {
                        for (Expense__c exp : ts.Expenses__r) {
                            expSum += (exp.Amount__c != null) ? Decimal.valueOf(String.valueOf(exp.Amount__c)) : 0.0;
                        }
                    }

                    if (expSum > 0) {
                        linesToInsert.add(new Invoice_Line__c(
                            Pxm_Invoice__c = parentInvoice.Id,
                            Timesheet__c = ts.Id,
                            Hours__c = 1,          
                            Bill_Rate__c = expSum,          
                            Name = 'Reimbursable Expenses',
                            Line_Description__c = ('Approved expenses for period ' + ts.Reporting_Week__c).left(255)
                        ));
                    }

                    // Mark Timesheet as processed
                    ts.Timesheet_Status__c = invoicedStatus;
                    timesheetsToUpdate.add(ts);
                }
            }
            
            if (!linesToInsert.isEmpty()) insert linesToInsert;
            if (!timesheetsToUpdate.isEmpty()) update timesheetsToUpdate;

            return 'Success: Generated ' + invoicesToInsert.size() + ' invoice(s).';

        } catch (Exception e) {
            Database.rollback(sp);
            throw createAuraException('Generation failed: ' + e.getMessage());
        }
    }

    // ==========================================
    // 5. DIRECTORY TRANSACTIONS
    // ==========================================
    public class EntitySummaryWrapper {
        @AuraEnabled public Id entityId { get; set; }
        @AuraEnabled public String entityName { get; set; }
        @AuraEnabled public String entityType { get; set; }
        @AuraEnabled public String status { get; set; }
    }

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

    private static EntitySummaryWrapper createEntityWrapper(Id recId, String recName, String recType, String status) {
        EntitySummaryWrapper wrap = new EntitySummaryWrapper();
        wrap.entityId = recId;
        wrap.entityName = recName;
        wrap.entityType = recType;
        wrap.status = status;
        return wrap;
    }

    // ==========================================
    // 6. EXCEPTION HANDLING UTILITIES
    // ==========================================
    public class CustomException extends Exception {}

    private static AuraHandledException createAuraException(String message) {
        AuraHandledException e = new AuraHandledException(message);
        e.setMessage(message); 
        return e;
    }
}