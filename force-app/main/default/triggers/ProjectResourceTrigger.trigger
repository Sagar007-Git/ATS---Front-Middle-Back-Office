trigger ProjectResourceTrigger on Project_Resource__c (after insert) {
    UniversalSyncEngine.executeSync(Trigger.new, 'Project_Resource__c');
}