public with sharing class UniversalSyncEngine {
    
    /**
     * @param newRecords - Trigger.new from any object
     * @param childObjectApiName - The API name of the object that fired the trigger
     */
    public static void executeSync(List<SObject> newRecords, String childObjectApiName) {
        
        // SAFETY 1: Null checks before doing anything
        if (newRecords == null || newRecords.isEmpty() || String.isBlank(childObjectApiName)) {
            return;
        }

        try {
            // 1. Fetch ONLY the Active Rules for the object that fired the trigger
            List<Bidirectional_Sync_Rule__mdt> rules = [
                SELECT DeveloperName, Child_Lookup_Field__c, Parent_Object_API_Name__c, Parent_Target_Field__c
                FROM Bidirectional_Sync_Rule__mdt
                WHERE Child_Object_API_Name__c = :childObjectApiName 
                AND Is_Active__c = true
            ];

            // Exit immediately if no rules exist (saves CPU time)
            if (rules.isEmpty()) return;

            // 2. Map to store Parents to update (Key = ParentId)
            // Using a Map prevents "Duplicate ID in List" errors if multiple children update the same parent
            Map<Id, SObject> parentsToUpdate = new Map<Id, SObject>();

            // 3. Process each newly created child record (Bulkified for Data Loader)
            for (SObject child : newRecords) {
                
                for (Bidirectional_Sync_Rule__mdt rule : rules) {
                    try {
                        // Dynamically extract the Parent ID and Child ID
                        Id parentId = (Id) child.get(rule.Child_Lookup_Field__c);
                        Id childId = (Id) child.get('Id');

                        // Only proceed if the child is actually linked to a parent
                        if (parentId != null && childId != null) {
                            
                            // 4. INSTANTIATE THE PARENT DYNAMICALLY
                            SObject parentRecord;
                            if (parentsToUpdate.containsKey(parentId)) {
                                parentRecord = parentsToUpdate.get(parentId);
                            } else {
                                // ⚡ ARCHITECT TRICK: This automatically knows what object type the Parent is 
                                // based purely on the Salesforce ID prefix. Extremely fast and 100% generic!
                                parentRecord = parentId.getSObjectType().newSObject(parentId);
                            }

                            // 5. Stamp the Child ID onto the Parent's Target Field
                            parentRecord.put(rule.Parent_Target_Field__c, childId);

                            // Store it back in our Map
                            parentsToUpdate.put(parentId, parentRecord);
                        }
                    } catch (Exception innerEx) {
                        // SAFETY 2: If a specific rule fails (e.g. you typed a field name wrong in Metadata),
                        // it catches the error here, logs it, and continues processing the OTHER records.
                        System.debug('Sync Engine Mapping Error on Rule [' + rule.DeveloperName + ']: ' + innerEx.getMessage());
                    }
                }
            }

            // 6. FIRE THE DML UPDATE
            if (!parentsToUpdate.isEmpty()) {
                // SAFETY 3: We use Database.update with "allOrNone = false". 
                // This means if one parent fails a validation rule, it doesn't roll back the others!
                Database.SaveResult[] results = Database.update(parentsToUpdate.values(), false);

                // Log any DML errors for the Admin to see in the Debug Logs
                for (Database.SaveResult sr : results) {
                    if (!sr.isSuccess()) {
                        for(Database.Error err : sr.getErrors()) {
                            System.debug('Sync Engine DML Error: ' + err.getStatusCode() + ': ' + err.getMessage() + ' on fields: ' + err.getFields());
                        }
                    }
                }
            }
            
        } catch (Exception ex) {
            // SAFETY 4: The Ultimate Catch-All. If the entire engine crashes, it will NOT stop 
            // the user from saving their Deal Sheet. It just logs the failure in the background.
            System.debug('Universal Sync Engine FATAL ERROR: ' + ex.getMessage() + '\n' + ex.getStackTraceString());
        }
    }
}