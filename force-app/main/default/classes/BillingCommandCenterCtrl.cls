public with sharing class BillingCommandCenterCtrl {
    
    // 1. FETCH DATA FOR THE UI
    @AuraEnabled(cacheable=true)
    public static List<Timesheet__c> getApprovedTimesheets() {
        return [
            SELECT Id, Name, Start_Date__c, End_Date__c, Total_Time_Hours__c, 
                   Client__c, Client__r.Name, 
                   Project_Resource__r.Candidate_Employee__r.Name
            FROM Timesheet__c
            WHERE Timesheet_Status__c = 'Approved'
            ORDER BY Client__r.Name ASC, Start_Date__c DESC
            LIMIT 1000 // UI limit, use filters for more
        ];
    }

    // 2. TRIGGER THE BACKGROUND GENERATOR
    @AuraEnabled
    public static String massGenerateTimesheetPDFs(List<Id> timesheetIds) {
        if (timesheetIds == null || timesheetIds.isEmpty()) {
            throw new AuraHandledException('No records selected.');
        }

        // Fetch data to construct nice file names (e.g. "Timesheet - John Doe - TS-001")
        List<Timesheet__c> tsList = [SELECT Id, Name, Project_Resource__r.Candidate_Employee__r.Name 
                                     FROM Timesheet__c WHERE Id IN :timesheetIds];

        Map<Id, String> idToFileNameMap = new Map<Id, String>();
        for (Timesheet__c ts : tsList) {
            String candName = String.isNotBlank(ts.Project_Resource__r?.Candidate_Employee__r?.Name) 
                              ? ts.Project_Resource__r.Candidate_Employee__r.Name : 'Consultant';
            idToFileNameMap.put(ts.Id, 'Timesheet - ' + candName + ' - ' + ts.Name);
        }

        // 🛑 PLACEHOLDER: Update this string when you build your Timesheet VF Page!
        String targetVfPage = 'YOUR_TIMESHEET_VF_PAGE_NAME_HERE'; 

        try {
            // Hand it to the background engine!
            System.enqueueJob(new PDFGeneratorQueueable(idToFileNameMap, targetVfPage));
            return 'Background PDF Generation started for ' + timesheetIds.size() + ' records. Check the files related list shortly!';
        } catch (Exception e) {
            throw new AuraHandledException('Error starting job: ' + e.getMessage());
        }
    }
}