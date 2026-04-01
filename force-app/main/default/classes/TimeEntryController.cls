public with sharing class TimeEntryController {
    
    @AuraEnabled(cacheable=true)
    public static Map<String, Object> getData(Id tsId) {
        // 1. Fetch the Parent Timesheet
        Timesheet__c ts = [SELECT Id, Start_Date__c, End_Date__c, Timesheet_Status__c, Status__c,
                                  Project_Resource__c, Project_Resource__r.Project__c, 
                                  Project_Resource__r.Candidate_Employee__c 
                           FROM Timesheet__c WHERE Id = :tsId LIMIT 1];

        // 2. Fetch existing Time Entries with the NEW fields
        List<Time_Entry__c> entries = [SELECT Id, Date__c, Hours_Worked_Number_Format__c, Shift_Type__c, 
                                              Start_Time__c, End_Time__c, Break_Time__c, Task__c, 
                                              Additional_Comments__c 
                                       FROM Time_Entry__c WHERE Timesheet__c = :tsId];

        // 3. Fetch Available Tasks tied to this Project for the Dropdown
        List<Task__c> projectTasks = new List<Task__c>();
        if (ts.Project_Resource__r.Project__c != null) {
            projectTasks = [SELECT Id, Name FROM Task__c 
                            WHERE Project__c = :ts.Project_Resource__r.Project__c 
                            ORDER BY Name];
        }

        return new Map<String, Object>{
            'ts' => ts,
            'entries' => entries,
            'tasks' => projectTasks
        };
    }

    @AuraEnabled
    public static void submitEntries(Id tsId, List<Time_Entry__c> entries) {
        try {
            // 1. Upsert the detailed Time Entries
            if (!entries.isEmpty()) {
                upsert entries;
            }

            // 2. Lock the parent Timesheet Status using ONLY the correct picklist field
            Timesheet__c tsToUpdate = new Timesheet__c(
                Id = tsId,
                Timesheet_Status__c = 'Submitted' 
                // 🛑 REMOVED: Status__c = 'Submitted'
            );
            update tsToUpdate;
            
        } catch (Exception e) {
            throw new AuraHandledException('Database Error: ' + e.getMessage());
        }
    }
}