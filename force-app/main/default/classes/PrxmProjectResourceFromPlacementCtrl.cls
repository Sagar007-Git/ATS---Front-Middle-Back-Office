public without sharing class PrxmProjectResourceFromPlacementCtrl {
    @AuraEnabled
    public static Map<String, Object> getProjectOverrides(Id placementId, Id projectId) {
        Map<String, Object> overrides = new Map<String, Object>();
        try {
            Placement__c placement = [SELECT Id, Candidate__c, Pay_Rate__c FROM Placement__c WHERE Id = :placementId LIMIT 1];
            Project__c project = [SELECT Id, Account__c FROM Project__c WHERE Id = :projectId LIMIT 1];
            
            overrides.put('Placement__c', placement.Id);
            overrides.put('Candidate_Employee__c', placement.Candidate__c);
            overrides.put('Pay_Rate__c', placement.Pay_Rate__c);
            
            overrides.put('Project__c', project.Id);
            overrides.put('Account__c', project.Account__c);
            
            return overrides;
        } catch(Exception e) {
            throw new AuraHandledException(e.getMessage());
        }
    }
}
