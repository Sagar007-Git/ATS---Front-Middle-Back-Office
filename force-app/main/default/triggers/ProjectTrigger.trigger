trigger ProjectTrigger on Project__c (after insert) {
    UniversalSyncEngine.executeSync(Trigger.new, 'Project__c');
}