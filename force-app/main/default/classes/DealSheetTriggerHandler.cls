public with sharing class DealSheetTriggerHandler {

    public static void afterUpdate(List<Deal_Sheet__c> newList, Map<Id, Deal_Sheet__c> oldMap) {
        List<Deal_Sheet__c> approvedSheets = new List<Deal_Sheet__c>();

        for (Deal_Sheet__c ds : newList) {
            // Trigger ONLY when Status changes to 'Approved'
            if (ds.Status__c == 'Approved' && oldMap.get(ds.Id).Status__c != 'Approved') {
                approvedSheets.add(ds);
            }
        }

        if (!approvedSheets.isEmpty()) {
            generateResourcesAndSyncPlacement(approvedSheets);
        }
    }

    private static void generateResourcesAndSyncPlacement(List<Deal_Sheet__c> sheets) {
        List<Project_Resource__c> resourcesToInsert = new List<Project_Resource__c>();
        List<Placement__c> placementsToUpdate = new List<Placement__c>();

        for (Deal_Sheet__c ds : sheets) {
            // 1. Create Resource with ALL REQUIRED FIELDS from your schema
            Project_Resource__c pr = new Project_Resource__c(
                Placement__c = ds.Placement__c,
                Project__c = ds.Project__c,
                Deal_Sheet__c = ds.Id,
                Account__c = ds.Client__c, // Mapped Client to Account
                Candidate_Employee__c = ds.Candidate__c, // FIXED: Was 'Contact__c'
                Start_Date__c = ds.Start_Date__c,
                End_Date__c = ds.End_Date__c,
                
                // --- MANDATORY FIELDS (Required by your Schema) ---
                Billable__c = true, 
                Compliance_Hold__c = false,
                Is_Current_Version__c = true,
                Bill_Rate__c = 0.00, // Update this if Deal Sheet has a rate field
                Pay_Rate__c = 0.00,  // Update this if Deal Sheet has a rate field
                Next_Timesheet_Date__c = Date.today().toStartOfWeek().addDays(7), // Example date
                Timesheet_Frequency__c = 'Weekly' // MUST match a valid picklist value in your org
            );
            resourcesToInsert.add(pr);

            // 2. Prepare Placement Sync
            placementsToUpdate.add(new Placement__c(
                Id = ds.Placement__c,
                Current_Project__c = ds.Project__c,
                Current_Active_Deal_Sheet__c = ds.Id
            ));
        }

        // 3. Perform DML (Errors will safely throw to UI if they fail)
        if (!resourcesToInsert.isEmpty()) {
            insert resourcesToInsert;
        }
        if (!placementsToUpdate.isEmpty()) {
            update placementsToUpdate;
        }
    }
}