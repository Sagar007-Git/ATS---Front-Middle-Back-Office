trigger DealSheetTrigger on Deal_Sheet__c (after insert, after update) {
    
    // 1. Fire your existing Sync Engine (Keep this doing its job!)
    UniversalSyncEngine.executeSync(Trigger.new, 'Deal_Sheet__c');
    
    // 2. Fire the Auto-Creation logic (Only on Update when Status might change)
    if (Trigger.isAfter && Trigger.isUpdate) {
        // This must match your handler class and method perfectly  
        DealSheetTriggerHandler.afterUpdate(Trigger.new, Trigger.oldMap);
    }
}