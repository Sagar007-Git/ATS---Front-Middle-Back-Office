public class TimesheetGenerationBatch implements Database.Batchable<sObject> {

    public Database.QueryLocator start(Database.BatchableContext bc) {
        // Using your exact API names. No dot-walking needed for Account or Rates!
        String query = 'SELECT Id, Account__c, Project__c, Candidate_Employee__c, ' +
                       'Bill_Rate__c, Pay_Rate__c, Billable__c, ' +
                       'Placement__c, Placement__r.Timesheet_Start_Day__c, ' +
                       'Start_Date__c, End_Date__c, Timesheet_Frequency__c, Next_Timesheet_Date__c ' +
                       'FROM Project_Resource__c ' +
                       'WHERE Next_Timesheet_Date__c <= TODAY ' +
                       'AND Status__c = \'Active\' ' + 
                       'AND Compliance_Hold__c = false'; // Safety first!
                       
        return Database.getQueryLocator(query);
    }

    public void execute(Database.BatchableContext bc, List<Project_Resource__c> scope) {
        if (!scope.isEmpty()) {
            TimesheetGenerationService.generateTimesheets(scope);
        }
    }

    public void finish(Database.BatchableContext bc) {
        System.debug('✅ Clean Architecture Timesheet Batch Completed.');
    }
}