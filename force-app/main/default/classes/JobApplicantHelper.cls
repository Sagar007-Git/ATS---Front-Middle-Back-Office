public with sharing class JobApplicantHelper {
    
    /**
     * Checks if a Placement record already exists for a specific Job Applicant.
     * @param applicantId The ID of the Job Applicant record.
     * @return The ID of the existing Placement, or null if none exists.
     */
    @AuraEnabled
    public static Id getExistingPlacementId(Id applicantId) {
        if (applicantId == null) {
            return null;
        }

        // Search for an existing placement linked to this Job Applicant
        List<Placement__c> placements = [
            SELECT Id 
            FROM Placement__c 
            WHERE Job_Applicant__c = :applicantId 
            LIMIT 1
        ];

        return (!placements.isEmpty()) ? placements[0].Id : null;
    }
}