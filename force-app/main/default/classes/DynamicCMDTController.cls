public with sharing class DynamicCMDTController {
    
    @AuraEnabled(cacheable=true)
    public static PopupResponse getPopupConfiguration(Id sourceRecordId, String actionName) {
        PopupResponse response = new PopupResponse();
        response.fields = new List<FieldWrapper>();

        // SAFETY 1: Block null inputs immediately
        if (sourceRecordId == null || String.isBlank(actionName)) {
            return response; 
        }

        // A. Query the Custom Metadata rules
        List<Action_Popup_Configuration__mdt> configs = [
            SELECT Target_Object__c, Target_Field__c, Source_Field__c, 
                   Is_Required__c, Is_Read_Only__c, Sort_Order__c
            FROM Action_Popup_Configuration__mdt
            WHERE Action_Name__c = :actionName
            ORDER BY Sort_Order__c ASC
        ];

        // SAFETY 2: If no metadata exists for this action, stop safely
        if (configs.isEmpty()) {
            throw new AuraHandledException('No metadata configuration found for Action Name: ' + actionName);
        }

        // Set the Target Object dynamically from the first CMDT record
        response.targetObjectName = configs[0].Target_Object__c;

        SObjectType sourceObjType = sourceRecordId.getSobjectType();
        Set<String> fieldsToQuery = new Set<String>();

        for (Action_Popup_Configuration__mdt config : configs) {
            if (String.isNotBlank(config.Source_Field__c)) {
                fieldsToQuery.add(config.Source_Field__c);
            }
        }

        SObject sourceRecord = null;
        
        // B. Dynamically query the Source Record (Only if we actually have fields to query)
        if (!fieldsToQuery.isEmpty()) {
            try {
                String query = 'SELECT Id, ' + String.join(new List<String>(fieldsToQuery), ',') + 
                               ' FROM ' + sourceObjType.getDescribe().getName() + 
                               ' WHERE Id = :sourceRecordId';
                sourceRecord = Database.query(query);
            } catch (Exception e) {
                // SAFETY 3: If the query fails (e.g., misspelled field, missing permissions), tell the UI
                throw new AuraHandledException('Error querying source record fields. Please check field names and permissions. Details: ' + e.getMessage());
            }
        }

        // C. Build the generic fields
        for (Action_Popup_Configuration__mdt config : configs) {
            FieldWrapper fw = new FieldWrapper();
            fw.fieldApiName = config.Target_Field__c;
            fw.isRequired = config.Is_Required__c;
            fw.isReadOnly = config.Is_Read_Only__c; 
            
            if (sourceRecord != null && String.isNotBlank(config.Source_Field__c)) {
                fw.defaultValue = resolveFieldValue(sourceRecord, config.Source_Field__c);
            } else {
                fw.defaultValue = null;
            }
            response.fields.add(fw);
        }

        return response;
    }

    // --- SAFETY 4: THE BULLETPROOF DOT RESOLVER ---
    private static Object resolveFieldValue(SObject record, String fieldPath) {
        if (record == null || String.isBlank(fieldPath)) return null;
        
        // If it's a flat field (e.g., 'Candidate__c'), return it directly
        if (!fieldPath.contains('.')) {
            try {
                return record.get(fieldPath);
            } catch (Exception e) {
                return null; // Field might not exist on the queried record
            }
        } 
        
        // If it's a relationship field (e.g., 'Job__r.Regular_Bill_Rate__c')
        List<String> parts = fieldPath.split('\\.');
        SObject currentRecord = record;
        
        for (Integer i = 0; i < parts.size() - 1; i++) {
            if (currentRecord == null) return null; // Stop if parent is blank
            
            try {
                currentRecord = currentRecord.getSObject(parts[i]);
            } catch (Exception e) {
                return null; // Invalid relationship name
            }
        }
        
        // Return the final field value, but only if the final parent isn't null
        if (currentRecord == null) return null;
        
        try {
            return currentRecord.get(parts[parts.size() - 1]);
        } catch (Exception e) {
            return null;
        }
    }

    // --- DATA WRAPPERS ---
    public class PopupResponse {
        @AuraEnabled public String targetObjectName; 
        @AuraEnabled public List<FieldWrapper> fields;
    }

    public class FieldWrapper {
        @AuraEnabled public String fieldApiName;
        @AuraEnabled public Boolean isRequired;
        @AuraEnabled public Boolean isReadOnly;
        @AuraEnabled public Object defaultValue;
    }
}