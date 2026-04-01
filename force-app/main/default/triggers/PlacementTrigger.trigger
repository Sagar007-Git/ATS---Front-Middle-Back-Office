trigger PlacementTrigger on Placement__c (after insert) {
    UniversalSyncEngine.executeSync(Trigger.new, 'Placement__c');
}