public class InvoiceDispatchBatch implements Database.Batchable<Id>, Database.AllowsCallouts {
    
    private List<Id> accountIds;
    private Date startDate;
    private Date endDate;

    public InvoiceDispatchBatch(List<Id> accountIds, Date startDate, Date endDate) {
        this.accountIds = accountIds;
        this.startDate = startDate;
        this.endDate = endDate;
    }

    public Iterable<Id> start(Database.BatchableContext bc) { 
        return accountIds; 
    }

    public void execute(Database.BatchableContext bc, List<Id> scope) {
        Id accId = scope[0]; 
        Account client = [SELECT Name, Billing_Email__c FROM Account WHERE Id = :accId LIMIT 1];
        
        List<Time_Entry__c> tesToUpdate = [
            SELECT Id FROM Time_Entry__c 
            WHERE Project__r.Client__c = :accId AND Date__c >= :startDate AND Date__c <= :endDate AND Time_Status__c = 'Approved'
        ];
        
        List<Expense__c> expsToUpdate = [
            SELECT Id FROM Expense__c 
            WHERE Project__r.Client__c = :accId AND Expense_Date__c >= :startDate AND Expense_Date__c <= :endDate AND Status__c = 'Approved'
        ];

        if(tesToUpdate.isEmpty() && expsToUpdate.isEmpty()) return;

        // 🌟 CLEAN UNIQUE ID: Readable Date + 3-Digit Random Suffix
        String safeName = client.Name.replaceAll('[^a-zA-Z0-9]', '');
        String shortName = safeName.length() >= 3 ? safeName.substring(0, 3).toUpperCase() : 'ACC';
        String timestamp = Datetime.now().format('yyyyMMdd-HHmm');
        Integer randomSuffix = Integer.valueOf(Math.random() * 899) + 100; // Generates a random number between 100-999
        
        String uniqueInvId = 'INV-' + shortName + '-' + timestamp + '-' + randomSuffix;

        // Lock Records & Stamp the ID
        for(Time_Entry__c te : tesToUpdate) {
            te.Time_Status__c = 'Invoiced';
            te.Invoice_Status__c = 'Sent';
            te.Virtual_Invoice_ID__c = uniqueInvId;
        }
        for(Expense__c exp : expsToUpdate) { 
            exp.Status__c = 'Sent'; 
            exp.Virtual_Invoice_ID__c = uniqueInvId;
        }

        PageReference pdfPage = Page.PxmInvoicePDF;
        pdfPage.getParameters().put('accId', accId);
        pdfPage.getParameters().put('startDate', String.valueOf(startDate).left(10));
        pdfPage.getParameters().put('endDate', String.valueOf(endDate).left(10));
        
        Blob pdfBlob;
        if(Test.isRunningTest()) { pdfBlob = Blob.valueOf('Mock PDF'); } 
        else { pdfBlob = pdfPage.getContentAsPDF(); }

        ContentVersion cv = new ContentVersion(
            Title = uniqueInvId, 
            PathOnClient = uniqueInvId + '.pdf', 
            VersionData = pdfBlob, 
            Description = uniqueInvId, 
            IsMajorVersion = true
        );
        insert cv;

        ContentVersion insertedCv = [SELECT ContentDocumentId FROM ContentVersion WHERE Id = :cv.Id LIMIT 1];
        insert new ContentDocumentLink(LinkedEntityId = accId, ContentDocumentId = insertedCv.ContentDocumentId, ShareType = 'V', Visibility = 'AllUsers');

        Messaging.EmailFileAttachment attachment = new Messaging.EmailFileAttachment();
        attachment.setFileName(uniqueInvId + '.pdf');
        attachment.setBody(pdfBlob);
        attachment.setContentType('application/pdf');
        
        Messaging.SingleEmailMessage email = new Messaging.SingleEmailMessage();
        email.setToAddresses(new String[] { client.Billing_Email__c }); 
        email.setSubject('Invoice from Enterprise Staffing - ' + uniqueInvId);
        email.setHtmlBody('<div style="font-family: Arial, sans-serif;"><h2>Invoice Ready</h2><p>Dear ' + client.Name + ' Accounts Payable,</p><p>Please find attached your invoice (<b>' + uniqueInvId + '</b>).</p><p>Thank you for your business!</p></div>');
        email.setFileAttachments(new Messaging.EmailFileAttachment[] { attachment });
        
        update tesToUpdate;
        update expsToUpdate;
        Messaging.sendEmail(new Messaging.SingleEmailMessage[] { email });
    }

    public void finish(Database.BatchableContext bc) { 
        // Optional logic to run when the batch finishes all clients
    }
}