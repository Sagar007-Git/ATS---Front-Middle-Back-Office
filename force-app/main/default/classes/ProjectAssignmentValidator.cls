public with sharing class ProjectAssignmentValidator {
    
    @AuraEnabled(cacheable=true)
    public static Boolean hasActiveAssignment(Id placementId) {
        if (placementId == null) return false;
        
        // Find any Project Resource for this Placement that hasn't ended yet
        List<Project_Resource__c> activeAssignments = [
            SELECT Id 
            FROM Project_Resource__c 
            WHERE Placement__c = :placementId 
            AND (End_Date__c = null OR End_Date__c >= TODAY)
            LIMIT 1
        ];
        
        // Return true if they are currently working on something
        return !activeAssignments.isEmpty();
    }
}