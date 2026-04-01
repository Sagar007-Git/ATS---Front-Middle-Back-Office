public hide with sharing class PlacementProjectController {

    @AuraEnabled(cacheable=true)
    public static Map<String, Object> checkActiveAssignments(Id placementId) {
        Map<String, Object> result = new Map<String, Object>();
        
        // Find the most recent active Project Resource
        List<Project_Resource__c> activeResources = [
            SELECT Id, Project__r.Name, Start_Date__c, End_Date__c 
            FROM Project_Resource__c 
            WHERE Placement__c = :placementId 
            AND (End_Date__c == null OR End_Date__c >= TODAY)
            ORDER BY End_Date__c DESC NULLS FIRST
            LIMIT 1
        ];

        if (!activeResources.isEmpty()) {
            result.put('hasActive', true);
            result.put('projectName', activeResources[0].Project__r.Name);
            result.put('startDate', activeResources[0].Start_Date__c);
            result.put('endDate', activeResources[0].End_Date__c);
        } else {
            result.put('hasActive', false);
        }
        return result;
    }

    @AuraEnabled
    public static String createDraftDealSheet(Id placementId, Id projectId, Date startDate, Date endDate) {
        try {
            Deal_Sheet__c ds = new Deal_Sheet__c(
                Placement__c = placementId,
                Project__c = projectId,
                Start_Date__c = startDate,
                End_Date__c = endDate,
                Status__c = 'Draft'
            );
            insert ds;
            return ds.Id;
        } catch (Exception e) {
            throw new AuraHandledException(e.getMessage());
        }
    }
}