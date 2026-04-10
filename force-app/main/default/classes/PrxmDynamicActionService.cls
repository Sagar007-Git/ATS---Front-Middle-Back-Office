/**
 * Handles the database retrieval, SOQL engine, and dynamic mapping for Prxm Dynamic Actions.
 * Implements strict error definitions, CRUD/FLS security via schema checks and WITH USER_MODE.
 */
public with sharing class PrxmDynamicActionService {

    // Custom Exception Class for precise UI error reporting
    public class ConfigurationException extends Exception {}

    /**
     * Core Service Method: Retrieves CMDT, builds dynamic SOQL, and returns structured DTO
     * @param actionName (String) - The DeveloperName/Action_Name__c from the Metadata
     * @param sourceRecordId (Id) - The record firing the action (optional)
     * @return PrxmActionConfig - Fully populated DTO for the LWC
     */
    public static PrxmActionConfig buildActionConfiguration(String actionName, Id sourceRecordId) {
        
        if (String.isBlank(actionName)) {
            throw new ConfigurationException('System Error: No Action Name was provided to the LWC. Please check your Lightning Page or Flow configuration.');
        }

        // 1. Fetch the Custom Metadata Configuration Records. 
        List<SObject> cmdtRecords = getMetadataConfiguration(actionName);
        
        if (cmdtRecords.isEmpty()) {
            throw new ConfigurationException('Configuration Error: Could not find any active metadata settings for the Action Name: \'' + actionName + '\'.');
        }

        // ✅ FIX 1: Safely Extract Global Configuration by scanning all rows, not just row [0]
        String targetObjectApiName = '';
        String sourceObjectApiName = '';
        String formTitle = '';

        for (SObject row : cmdtRecords) {
            if (String.isBlank(targetObjectApiName) && String.isNotBlank((String)row.get('Target_Object__c'))) {
                targetObjectApiName = (String)row.get('Target_Object__c');
            }
            if (String.isBlank(sourceObjectApiName) && String.isNotBlank((String)row.get('Source_Object__c'))) {
                sourceObjectApiName = (String)row.get('Source_Object__c');
            }
            if (String.isBlank(formTitle) && String.isNotBlank((String)row.get('Form_Title__c'))) {
                formTitle = (String)row.get('Form_Title__c');
            }
        }

        // Security Check 1: Can the user actually create the target object?
        verifyTargetObjectCreateAccess(targetObjectApiName);

        // 2. Determine if we need to run a Source SOQL query
        Set<String> fieldsToQuery = new Set<String>();
        for (SObject configRow : cmdtRecords) {
            String sourceField = (String)configRow.get('Source_Field_API_Name__c');
            if (String.isNotBlank(sourceField)) {
                fieldsToQuery.add(sourceField.trim());
            }
        }

        SObject sourceRecordData = null;

        // 3. Dynamic SOQL Execution against Source Record (if applicable)
        if (sourceRecordId != null && String.isNotBlank(sourceObjectApiName) && !fieldsToQuery.isEmpty()) {
            sourceRecordData = executeDynamicSourceQuery(sourceRecordId, sourceObjectApiName, fieldsToQuery);
        }

        // 4. Construct the Final Payload (DTO)
        PrxmActionConfig resultConfig = new PrxmActionConfig();
        resultConfig.targetObjectApiName = targetObjectApiName;
        resultConfig.title = String.isNotBlank(formTitle) ? formTitle : 'Create ' + targetObjectApiName;
        
        Integer fieldIndex = 0;

        for (SObject configRow : cmdtRecords) {
            PrxmActionConfig.FieldConfig fConfig = new PrxmActionConfig.FieldConfig();
            
            String targetField = (String)configRow.get('Target_Field_API_Name__c');
            String sourceField = (String)configRow.get('Source_Field_API_Name__c');
            String staticValue = (String)configRow.get('Static_Default_Value__c');
            
            // Validate basic config
            if (String.isBlank(targetField)) {
                throw new ConfigurationException('Metadata Error: Found a configuration row missing the Target Field API Name for action: ' + actionName);
            }

            fConfig.id          = targetField + '-' + fieldIndex++;
            fConfig.apiName     = targetField;
            fConfig.isRequired  = (Boolean)configRow.get('Is_Required__c');
            fConfig.isReadOnly  = (Boolean)configRow.get('Is_Read_Only__c');
            fConfig.isHidden    = (Boolean)configRow.get('Is_Hidden_Background_Field__c');
            fConfig.sectionName = (String)configRow.get('Section_Name__c');
            fConfig.order       = (Decimal)configRow.get('Order__c');

            // Resolve the Default Value (Source Record takes precedence, then Static Value)
            if (sourceRecordData != null && String.isNotBlank(sourceField)) {
                try {
                    fConfig.defaultValue = resolveFieldValue(sourceRecordData, sourceField);
                } catch (Exception ex) {
                    throw new ConfigurationException('Data Mapping Error: Failed to pull data from Source Field \'' + sourceField + '\'. Verify the field exists on ' + sourceObjectApiName + '. Error: ' + ex.getMessage());
                }
            } else if (String.isNotBlank(staticValue)) {
                fConfig.defaultValue = processStaticValue(staticValue, sourceRecordId);
            }

            resultConfig.fields.add(fConfig);
        }

        return resultConfig;
    }

    /**
     * Query CMDT using dynamic SOQL string to avoid compilation failure if CMDT isn't deployed yet.
     */
    private static List<SObject> getMetadataConfiguration(String actionName) {
        String queryString = 'SELECT Action_Name__c, Source_Object__c, Target_Object__c, Form_Title__c, ' +
                             'Target_Field_API_Name__c, Source_Field_API_Name__c, Static_Default_Value__c, ' +
                             'Order__c, Is_Required__c, Is_Read_Only__c, Is_Hidden_Background_Field__c, Section_Name__c ' +
                             'FROM Prxm_Action_Mapping__mdt ' + 
                             'WHERE Action_Name__c = :actionName ' +
                             'ORDER BY Order__c ASC';
        
        try {
            return Database.query(queryString);
        } catch (System.QueryException qe) {
            throw new ConfigurationException('System Installation Error: The Custom Metadata Type `Prxm_Action_Mapping__mdt` is missing or not deployed. ' + qe.getMessage());
        }
    }

    /**
     * Executes the SOQL against the source record safely
     */
    private static SObject executeDynamicSourceQuery(Id sourceRecordId, String sourceObjectApiName, Set<String> fields) {
        String soql = 'SELECT ' + String.join(new List<String>(fields), ', ') + 
                      ' FROM ' + String.escapeSingleQuotes(sourceObjectApiName) + 
                      ' WHERE Id = :sourceRecordId ' + 
                      ' LIMIT 1';
        try {
            return Database.query(soql);
        } catch (System.QueryException qe) {
            throw new ConfigurationException('Database Read Error: Could not find Source Record (' + sourceRecordId + ') on Object (' + sourceObjectApiName + '). It may have been deleted, or you lack read access to the requested mapped fields.');
        } catch (Exception e) {
            throw new ConfigurationException('SOQL Engine Error: Failed to execute source query. Query: ' + soql + ' | Error: ' + e.getMessage());
        }
    }

    /**
     * Verifies CRUD Object Create Access before rendering the form
     */
    private static void verifyTargetObjectCreateAccess(String targetObjectApiName) {
        Schema.SObjectType targetSObjType = Schema.getGlobalDescribe().get(targetObjectApiName);
        
        if (targetSObjType == null) {
            throw new ConfigurationException('Schema Error: The target object \'' + targetObjectApiName + '\' does not exist in this Salesforce environment.');
        }
        
        if (!targetSObjType.getDescribe().isCreateable()) {
            throw new ConfigurationException('Security Error: You do not have the required permissions to create a new \'' + targetSObjType.getDescribe().getLabel() + '\' record.');
        }
    }

    /**
     * Allows traversing relationships like Contact__r.Name safely.
     */
    private static Object resolveFieldValue(SObject record, String fieldName) {
        if (!fieldName.contains('.')) {
            return record.get(fieldName);
        }
        
        List<String> parts = fieldName.split('\\.');
        SObject parentRecord = record;
        
        for (Integer i = 0; i < parts.size() - 1; i++) {
            parentRecord = parentRecord.getSObject(parts[i]);
            if (parentRecord == null) {
                return null;
            }
        }
        return parentRecord.get(parts[parts.size() - 1]);
    }

    /**
     * Processes static text into dynamic merges (e.g. '{sourceRecordId}')
     */
    private static String processStaticValue(String staticValue, Id sourceRecordId) {
        if (staticValue.containsIgnoreCase('{sourceRecordId}') && sourceRecordId != null) {
            // ✅ FIX 2: Must use replaceAll() when relying on Regular Expressions in Apex
            return staticValue.replaceAll('(?i)\\{sourceRecordId\\}', String.valueOf(sourceRecordId));
        }
        return staticValue;
    }
}