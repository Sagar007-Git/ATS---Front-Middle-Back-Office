/**
 * The AuraEnabled Controller for the generic PrxmDynamicAction LWC.
 * Strictly acts as the interface layer. Defers all database logic to PrxmDynamicActionService.
 * Implements specific exception handling to ensure the UI gets actionable error toast messages.
 */
public with sharing class PrxmDynamicActionCtrl {

    /**
     * Called by the LWC during Initialization (connectedCallback)
     * @param actionName The configured DeveloperName from the Lightning App Builder / Flow
     * @param sourceRecordId The Id of the record the action was launched from
     * @return PrxmActionConfig The structured metadata wrapper
     */
    @AuraEnabled(cacheable=false)
    public static PrxmActionConfig getActionConfiguration(String actionName, String sourceRecordId) {
        
        try {
            
            // Validate incoming params
            Id parsedSourceId = null;
            if (String.isNotBlank(sourceRecordId)) {
                try {
                    parsedSourceId = (Id)sourceRecordId;
                } catch (Exception e) {
                    throw new AuraHandledException('Invalid Record ID format received: ' + sourceRecordId);
                }
            }

            // Defer execution entirely to the Service layer
            return PrxmDynamicActionService.buildActionConfiguration(actionName, parsedSourceId);

        } 
        catch (PrxmDynamicActionService.ConfigurationException cex) {
            // These are expected business-logic / metadata setup errors. Show them cleanly.
            System.debug(LoggingLevel.ERROR, 'PrxmDynamicAction: Configuration Exception - ' + cex.getMessage());
            AuraHandledException auraEx = new AuraHandledException(cex.getMessage());
            auraEx.setMessage(cex.getMessage());
            throw auraEx;
        } 
        catch (System.NoAccessException nae) {
            // FLS or Object level security exceptions caught during WITH USER_MODE execution
            System.debug(LoggingLevel.ERROR, 'PrxmDynamicAction: Security Access Exception - ' + nae.getMessage());
            String msg = 'Security Error: You do not have the required field or object access to run this action. Please contact your Salesforce Administrator. (' + nae.getMessage() + ')';
            AuraHandledException auraEx = new AuraHandledException(msg);
            auraEx.setMessage(msg);
            throw auraEx;
        } 
        catch (System.TypeException te) {
            // Usually happens if casting generic objects incorrectly based on metadata mismatch
            System.debug(LoggingLevel.ERROR, 'PrxmDynamicAction: Type Conversion Exception - ' + te.getMessage());
            String msg = 'Configuration Type Error: One of the fields mapped in the Custom Metadata Type cannot hold the data type assigned to it. ' + te.getMessage();
            AuraHandledException auraEx = new AuraHandledException(msg);
            auraEx.setMessage(msg);
            throw auraEx;
        } 
        catch (Exception ex) {
            // Ultimate fallback for unhandled 500-level Apex errors
            System.debug(LoggingLevel.ERROR, 'PrxmDynamicAction: Unexpected System Error - ' + ex.getMessage() + ' | Stack Trace: ' + ex.getStackTraceString());
            String msg = 'Unexpected System Error (' + ex.getTypeName() + '). Please review the Apex Debug Logs. Message: ' + ex.getMessage();
            AuraHandledException auraEx = new AuraHandledException(msg);
            auraEx.setMessage(msg);
            throw auraEx;
        }
    }

    @AuraEnabled(cacheable=true)
    public static Id getExistingPlacementId(Id jobApplicantId) {
        if (jobApplicantId == null) {
            return null;
        }

        try {
            // ✅ FIX 1: We query the Job Applicant to see if the lookup field is populated!
            // IMPORTANT: Change "Placement__c" to the exact API name of your lookup field on the Job Applicant object
            Job_Applicant__c applicant = [
                SELECT Placement__c 
                FROM Job_Applicant__c 
                WHERE Id = :jobApplicantId 
                LIMIT 1
            ];
            
            return applicant.Placement__c; // Will return null if empty, or the ID if it exists
        } catch (Exception e) {
            throw new AuraHandledException('Error checking Job Applicant: ' + e.getMessage());
        }
    }

    // ✅ FIX 2: A new method to manually link them together since we don't have a Trigger
    @AuraEnabled
    public static void linkPlacementToApplicant(Id jobApplicantId, Id placementId) {
        try {
            // IMPORTANT: Change "Placement__c" to the exact API name of your lookup field
            Job_Applicant__c appToUpdate = new Job_Applicant__c(
                Id = jobApplicantId,
                Placement__c = placementId 
            );
            update appToUpdate;
        } catch (Exception e) {
            throw new AuraHandledException('Failed to link Placement to Applicant: ' + e.getMessage());
        }
    }
}