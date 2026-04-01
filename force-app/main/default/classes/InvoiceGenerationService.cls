public with sharing class InvoiceGenerationService {

    // ============================================================================
    // CONFIGURATION CONSTANTS
    // ============================================================================
    private static final String TS_STATUS_APPROVED = 'Approved';
    private static final String TS_STATUS_INVOICED = 'Invoiced';
    private static final String INV_STATUS_DRAFT = 'Draft';
    private static final Integer DEFAULT_DUE_DAYS = 30;

    @AuraEnabled
    public static String generateInvoices(List<Id> timesheetIds) {
        if (timesheetIds == null || timesheetIds.isEmpty()) {
            throw createAuraException('No Timesheets were selected for generation.');
        }

        Savepoint sp = Database.setSavepoint();

        try {
            List<Timesheet__c> validTimesheets = fetchAndValidateTimesheets(timesheetIds);
            Map<Id, List<Timesheet__c>> clientToTimesheetsMap = groupTimesheetsByClient(validTimesheets);
            Map<Id, Invoice__c> clientToInvoiceMap = createInvoiceHeaders(clientToTimesheetsMap.keySet());
            List<Invoice_Line__c> invoiceLines = createInvoiceLines(clientToTimesheetsMap, clientToInvoiceMap);
            insert invoiceLines;
            updateTimesheetsAsInvoiced(validTimesheets);

            return 'Success! Generated ' + clientToInvoiceMap.size() + ' invoice(s) with ' + invoiceLines.size() + ' line items.';

        } catch (Exception e) {
            Database.rollback(sp);
            throw createAuraException('Invoice Generation Failed: ' + e.getMessage());
        }
    }

    private static List<Timesheet__c> fetchAndValidateTimesheets(List<Id> timesheetIds) {
        // 🛑 UPDATED SOQL: Now pulls Total_Time_Hours__c and the detailed Time_Entries__r subquery
        List<Timesheet__c> timesheets = [
            SELECT Id, Name, Client__c, Start_Date__c, End_Date__c, Total_Time_Hours__c, Status__c, Reporting_Week__c,
                   Task__c, Task__r.Name, Task__r.Bill_Rate__c, Task__r.Account__c, 
                   Project_Resource__r.Bill_Rate__c, 
                   Project_Resource__r.Placement__r.Bill_Rate__c,
                   Project_Resource__r.Candidate_Employee__r.Name,
                   (SELECT Amount__c FROM Expenses__r WHERE Status__c = :TS_STATUS_APPROVED),
                   (SELECT Id, Date__c, Hours_Worked_Number_Format__c, Task__c, Task__r.Name, Task__r.Bill_Rate__c, Additional_Comments__c 
                    FROM Time_Entries__r 
                    WHERE Hours_Worked_Number_Format__c > 0)
            FROM Timesheet__c
            WHERE Id IN :timesheetIds
            FOR UPDATE 
        ];

        if (timesheets.isEmpty()) throw new CustomException('No matching records found in the database.');

        for (Timesheet__c ts : timesheets) {
            if (ts.Status__c != TS_STATUS_APPROVED) {
                throw new CustomException('Timesheet ' + ts.Name + ' is not in Approved status.');
            }
            Id billingAccountId = resolveBillingAccount(ts);
            if (billingAccountId == null) {
                throw new CustomException('Timesheet ' + ts.Name + ' is missing a billing Account.');
            }
        }
        return timesheets;
    }

    private static Id resolveBillingAccount(Timesheet__c ts) {
        if (ts.Task__r?.Account__c != null) return ts.Task__r.Account__c; 
        return ts.Client__c; 
    }

    private static Map<Id, List<Timesheet__c>> groupTimesheetsByClient(List<Timesheet__c> timesheets) {
        Map<Id, List<Timesheet__c>> groupedMap = new Map<Id, List<Timesheet__c>>();
        for (Timesheet__c ts : timesheets) {
            Id billingAccountId = resolveBillingAccount(ts);
            if (!groupedMap.containsKey(billingAccountId)) groupedMap.put(billingAccountId, new List<Timesheet__c>());
            groupedMap.get(billingAccountId).add(ts);
        }
        return groupedMap;
    }

    private static Map<Id, Invoice__c> createInvoiceHeaders(Set<Id> clientIds) {
        List<Invoice__c> invoicesToInsert = new List<Invoice__c>();
        Map<Id, Invoice__c> clientToInvoiceMap = new Map<Id, Invoice__c>();

        for (Id clientId : clientIds) {
            Invoice__c inv = new Invoice__c(
                Account__c = clientId,
                Invoice_Date__c = Date.today(),
                Due_Date__c = Date.today().addDays(DEFAULT_DUE_DAYS)
            );
            invoicesToInsert.add(inv);
            clientToInvoiceMap.put(clientId, inv);
        }
        insert invoicesToInsert; 
        return clientToInvoiceMap;
    }

    private static List<Invoice_Line__c> createInvoiceLines(Map<Id, List<Timesheet__c>> clientToTimesheetsMap, Map<Id, Invoice__c> clientToInvoiceMap) {
        List<Invoice_Line__c> linesToInsert = new List<Invoice_Line__c>();

        for (Id clientId : clientToTimesheetsMap.keySet()) {
            Invoice__c parentInvoice = clientToInvoiceMap.get(clientId);

            for (Timesheet__c ts : clientToTimesheetsMap.get(clientId)) {
                
                // Base Fallback Rates
                Decimal resourceRate = (ts.Project_Resource__r?.Bill_Rate__c != null) ? Decimal.valueOf(String.valueOf(ts.Project_Resource__r.Bill_Rate__c)) : 0.0;
                Decimal placementRate = (ts.Project_Resource__r?.Placement__r?.Bill_Rate__c != null) ? Decimal.valueOf(String.valueOf(ts.Project_Resource__r.Placement__r.Bill_Rate__c)) : 0.0;
                Decimal baseRate = (resourceRate > 0) ? resourceRate : placementRate;
                String candidateName = String.isNotBlank(ts.Project_Resource__r?.Candidate_Employee__r?.Name) ? ts.Project_Resource__r.Candidate_Employee__r.Name : 'Unknown Resource';

                // --- 1. GENERATE DETAILED DAILY LINES FROM TIME ENTRIES ---
                if (ts.Time_Entries__r != null && !ts.Time_Entries__r.isEmpty()) {
                    for (Time_Entry__c te : ts.Time_Entries__r) {
                        
                        Decimal dailyHours = Decimal.valueOf(String.valueOf(te.Hours_Worked_Number_Format__c));
                        
                        // Check if a specific task was selected for this day, otherwise fallback to timesheet task
                        Decimal dailyRate = baseRate;
                        if (te.Task__r?.Bill_Rate__c != null) {
                            dailyRate = Decimal.valueOf(String.valueOf(te.Task__r.Bill_Rate__c));
                        } else if (ts.Task__r?.Bill_Rate__c != null) {
                            dailyRate = Decimal.valueOf(String.valueOf(ts.Task__r.Bill_Rate__c));
                        }

                        String taskName = String.isNotBlank(te.Task__r?.Name) ? te.Task__r.Name : (String.isNotBlank(ts.Task__r?.Name) ? ts.Task__r.Name : 'Labor');
                        String comments = String.isNotBlank(te.Additional_Comments__c) ? ' | Notes: ' + te.Additional_Comments__c : '';
                        String dateStr = (te.Date__c != null) ? String.valueOf(te.Date__c) : '';

                        linesToInsert.add(new Invoice_Line__c(
                            Pxm_Invoice__c = parentInvoice.Id,
                            Timesheet__c = ts.Id,
                            Hours__c = dailyHours,      
                            Bill_Rate__c = dailyRate,        
                            Name = (taskName + ' (' + dateStr + ')').left(80), 
                            Line_Description__c = ('Candidate: ' + candidateName + comments).left(255)
                        ));
                    }
                } 
                // --- FALLBACK: IF NO DETAILED ENTRIES EXIST BUT HOURS DO ---
                else if (ts.Total_Time_Hours__c != null && ts.Total_Time_Hours__c > 0) {
                    Decimal totalHours = Decimal.valueOf(String.valueOf(ts.Total_Time_Hours__c));
                    Decimal fallbackRate = (ts.Task__r?.Bill_Rate__c != null) ? Decimal.valueOf(String.valueOf(ts.Task__r.Bill_Rate__c)) : baseRate;

                    linesToInsert.add(new Invoice_Line__c(
                        Pxm_Invoice__c = parentInvoice.Id,
                        Timesheet__c = ts.Id,
                        Hours__c = totalHours,      
                        Bill_Rate__c = fallbackRate,        
                        Name = 'Standard Labor'.left(80), 
                        Line_Description__c = ('Candidate: ' + candidateName + ' | Week: ' + ts.Reporting_Week__c).left(255)
                    ));
                }

                // --- 2. GENERATE EXPENSE LINE ---
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
            }
        }
        return linesToInsert;
    }

    private static void updateTimesheetsAsInvoiced(List<Timesheet__c> timesheets) {
        List<Timesheet__c> timesheetsToUpdate = new List<Timesheet__c>();
        for (Timesheet__c ts : timesheets) {
            timesheetsToUpdate.add(new Timesheet__c(Id = ts.Id, Status__c = TS_STATUS_INVOICED));
        }
        update timesheetsToUpdate;
    }

    public class CustomException extends Exception {}

    private static AuraHandledException createAuraException(String message) {
        AuraHandledException e = new AuraHandledException(message);
        e.setMessage(message);
        return e;
    }
}