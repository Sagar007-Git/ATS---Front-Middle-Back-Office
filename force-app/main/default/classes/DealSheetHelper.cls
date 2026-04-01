public with sharing class DealSheetHelper {
    
    public static void createProjectResourceOnApproval(List<Deal_Sheet__c> newList, Map<Id, Deal_Sheet__c> oldMap) {
        List<Project_Resource__c> resourcesToInsert = new List<Project_Resource__c>();
        
        for (Deal_Sheet__c ds : newList) {
            // Get the old version of the record to check if Status actually changed
            Deal_Sheet__c oldDs = (oldMap != null) ? oldMap.get(ds.Id) : null;
            
            // Trigger ONLY when Status changes to 'Approved'
            if (ds.Status__c == 'Approved' && (oldDs == null || oldDs.Status__c != 'Approved')) {
                
                Project_Resource__c pr = new Project_Resource__c();
                
                // Map the core relationship fields
                pr.Placement__c = ds.Placement__c;
                pr.Project__c = ds.Project__c;
                // Assuming you have a Deal_Sheet__c lookup on Project Resource:
                pr.Deal_Sheet__c = ds.Id; 
                
                // If your Project Resource has a Candidate lookup, map it:
                pr.Candidate_Employee__c = ds.Candidate__c;
                
                // Map the dates
                pr.Start_Date__c = ds.Start_Date__c;
                pr.End_Date__c = ds.End_Date__c;
                    
                // Set default status for the new resource
                // pr.Status__c = 'Active'; 
                
                resourcesToInsert.add(pr);
            }
        }
        
        // Insert the new resources if any were created
        if (!resourcesToInsert.isEmpty()) {
            try {
                insert resourcesToInsert;
                System.debug('Successfully auto-created ' + resourcesToInsert.size() + ' Project Resources.');
            } catch (Exception e) {
                System.debug('Error creating Project Resources: ' + e.getMessage());
            }
        }
    }
}