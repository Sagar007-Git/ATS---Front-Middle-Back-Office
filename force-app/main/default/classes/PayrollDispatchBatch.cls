public class PayrollDispatchBatch implements Database.Batchable<Id>, Database.AllowsCallouts {
    
    private List<Id> candidateIds;
    private Date startDate;
    private Date endDate;

    public PayrollDispatchBatch(List<Id> candidateIds, Date startDate, Date endDate) {
        this.candidateIds = candidateIds;
        this.startDate = startDate;
        this.endDate = endDate;
    }

    public Iterable<Id> start(Database.BatchableContext bc) { 
        return candidateIds; 
    }

    public void execute(Database.BatchableContext bc, List<Id> scope) {
        Id candId = scope[0]; 
        Contact candidate = [SELECT Name, Email FROM Contact WHERE Id = :candId LIMIT 1];
        
        List<Time_Entry__c> tesToUpdate = [
            SELECT Id FROM Time_Entry__c 
            WHERE Contact__c = :candId AND Date__c >= :startDate AND Date__c <= :endDate AND Time_Status__c = 'Approved'
        ];
        
        if(tesToUpdate.isEmpty()) return;

        // 🌟 CLEAN UNIQUE ID: Readable Date + 3-Digit Random Suffix
        String safeName = candidate.Name.replaceAll('[^a-zA-Z0-9]', '');
        String shortName = safeName.length() >= 3 ? safeName.substring(0, 3).toUpperCase() : 'CAN';
        String timestamp = Datetime.now().format('yyyyMMdd-HHmm');
        Integer randomSuffix = Integer.valueOf(Math.random() * 899) + 100; 
        
        String uniquePayId = 'PAY-' + shortName + '-' + timestamp + '-' + randomSuffix;

        for(Time_Entry__c te : tesToUpdate) {
            te.Time_Status__c = 'Processed';
            te.Payroll_Status__c = 'Sent';
            te.Virtual_Payroll_ID__c = uniquePayId;
        }

        PageReference pdfPage = Page.PxmPayrollPDF;
        pdfPage.getParameters().put('candId', candId);
        pdfPage.getParameters().put('startDate', String.valueOf(startDate).left(10));
        pdfPage.getParameters().put('endDate', String.valueOf(endDate).left(10));
        
        Blob pdfBlob;
        if(Test.isRunningTest()) { pdfBlob = Blob.valueOf('Mock PDF'); } 
        else { pdfBlob = pdfPage.getContentAsPDF(); }

        ContentVersion cv = new ContentVersion(
            Title = uniquePayId, 
            PathOnClient = uniquePayId + '.pdf', 
            VersionData = pdfBlob, 
            Description = uniquePayId, 
            IsMajorVersion = true
        );
        insert cv;

        ContentVersion insertedCv = [SELECT ContentDocumentId FROM ContentVersion WHERE Id = :cv.Id LIMIT 1];
        insert new ContentDocumentLink(LinkedEntityId = candId, ContentDocumentId = insertedCv.ContentDocumentId, ShareType = 'V', Visibility = 'AllUsers');

        Messaging.EmailFileAttachment attachment = new Messaging.EmailFileAttachment();
        attachment.setFileName(uniquePayId + '.pdf');
        attachment.setBody(pdfBlob);
        attachment.setContentType('application/pdf');
        
        Messaging.SingleEmailMessage email = new Messaging.SingleEmailMessage();
        email.setToAddresses(new String[] { candidate.Email }); 
        email.setSubject('Payroll Stub from Enterprise Staffing - ' + uniquePayId);
        email.setHtmlBody('<div style="font-family: Arial, sans-serif;"><h2>Payroll Stub Ready</h2><p>Dear ' + candidate.Name + ',</p><p>Please find attached your payroll stub (<b>' + uniquePayId + '</b>).</p><p>Thank you for your hard work!</p></div>');
        email.setFileAttachments(new Messaging.EmailFileAttachment[] { attachment });
        
        update tesToUpdate;
        Messaging.sendEmail(new Messaging.SingleEmailMessage[] { email });
    }

    public void finish(Database.BatchableContext bc) { 
        // Optional logic to run when the batch finishes all candidates
    }
}