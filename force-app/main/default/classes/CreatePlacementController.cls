public with sharing class CreatePlacementController {
    
    @AuraEnabled(cacheable=true)
    public static InitWrapper getInitialData(Id applicantId) {
        InitWrapper result = new InitWrapper();
        
        // 1. Check if a Placement already exists for this Job Applicant
        List<Placement__c> existingPlacements = [
            SELECT Id FROM Placement__c 
            WHERE Job_Applicant__c = :applicantId LIMIT 1
        ];
        
        if (!existingPlacements.isEmpty()) {
            result.placementExists = true;
            result.existingPlacementId = existingPlacements[0].Id;
            return result;
        }
        
        // 2. Get Job Applicant details to pre-fill the Placement form
        // IMPORTANT: Verify these field API names match your Job_Applicant__c object!
        Job_Applicant__c applicant = [
            SELECT Id, Contact__c, Job__c 
            FROM Job_Applicant__c 
            WHERE Id = :applicantId LIMIT 1
        ];
        
        result.placementExists = false;
        result.defaultApplicantId = applicant.Id;
        result.defaultCandidate = applicant.Contact__c; // Update API name if needed
        result.defaultJob = applicant.Job__c;           // Update API name if needed
        
        return result;
    }
    
    // Wrapper class to send data to the LWC
    public class InitWrapper {
        @AuraEnabled public Boolean placementExists;
        @AuraEnabled public Id existingPlacementId;
        @AuraEnabled public Id defaultApplicantId;
        @AuraEnabled public Id defaultCandidate;
        @AuraEnabled public Id defaultJob;
    }
}