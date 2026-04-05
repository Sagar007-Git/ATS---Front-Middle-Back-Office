public class InvoiceDispatchQueueable implements Queueable, Database.AllowsCallouts {
    
    private List<Id> allInvoiceIds;

    public InvoiceDispatchQueueable(List<Id> invoiceIds) {
        this.allInvoiceIds = invoiceIds;
    }

    public void execute(QueueableContext context) {
        if (allInvoiceIds == null || allInvoiceIds.isEmpty()) return;

        // 🛡️ Batch size of 5 to protect CPU and Callout limits
        Integer batchSize = Math.min(allInvoiceIds.size(), 5);
        List<Id> processNow = new List<Id>();
        List<Id> processLater = new List<Id>();

        for (Integer i = 0; i < allInvoiceIds.size(); i++) {
            if (i < batchSize) processNow.add(allInvoiceIds[i]);
            else processLater.add(allInvoiceIds[i]);
        }

        try {
            // Step 1: Query Records
            List<Invoice__c> invoicesToProcess = queryInvoices(processNow);

            // Step 2: Generate PDFs and Save to Salesforce Files
            Map<Id, Blob> invoiceIdToPdfBlob = new Map<Id, Blob>();
            List<ContentVersion> cvsToInsert = generatePdfs(invoicesToProcess, invoiceIdToPdfBlob);
            
            if (!cvsToInsert.isEmpty()) {
                insert cvsToInsert;
            }

            // Step 3: Send Emails and Update Status (ONLY if email succeeds)
            sendEmailsAndUpdateStatus(invoicesToProcess, invoiceIdToPdfBlob);

        } catch (Exception e) {
            System.debug(LoggingLevel.ERROR, 'Fatal Error in Dispatch Queueable: ' + e.getMessage() + '\n' + e.getStackTraceString());
        }

        // Step 4: Chain the next batch of records if there are more
        if (!processLater.isEmpty()) {
            System.enqueueJob(new InvoiceDispatchQueueable(processLater));
        }
    }

    // =========================================================================
    // HELPER 1: QUERY DATA
    // =========================================================================
    private List<Invoice__c> queryInvoices(List<Id> invoiceIds) {
        return [
            SELECT Id, Name, Account__c, Account__r.Name, Account__r.Billing_Email__c,
                   Invoice_Date__c, Due_Date__c 
            FROM Invoice__c 
            WHERE Id IN :invoiceIds
        ];
    }

    // =========================================================================
    // HELPER 2: GENERATE PDFs
    // =========================================================================
    private List<ContentVersion> generatePdfs(List<Invoice__c> invoices, Map<Id, Blob> pdfMap) {
        List<ContentVersion> filesToInsert = new List<ContentVersion>();
        
        for (Invoice__c inv : invoices) {
            try {
                PageReference pdfPage = new PageReference('/apex/PxmInvoicePDF?id=' + inv.Id);
                Blob pdfBlob = Test.isRunningTest() ? Blob.valueOf('Test PDF') : pdfPage.getContentAsPDF();
                
                pdfMap.put(inv.Id, pdfBlob);
                
                String fileName = 'Invoice - ' + inv.Name + ' - ' + inv.Account__r.Name;
                filesToInsert.add(new ContentVersion(
                    Title = fileName,
                    PathOnClient = fileName + '.pdf',
                    VersionData = pdfBlob,
                    IsMajorVersion = true,
                    FirstPublishLocationId = inv.Id // Links file directly to the Invoice
                ));
            } catch (Exception e) {
                System.debug(LoggingLevel.ERROR, 'Failed to generate PDF for Invoice ' + inv.Name + ': ' + e.getMessage());
            }
        }
        return filesToInsert;
    }

    // =========================================================================
    // HELPER 3: BUILD EMAILS & UPDATE STATUS
    // =========================================================================
    private void sendEmailsAndUpdateStatus(List<Invoice__c> invoices, Map<Id, Blob> pdfMap) {
        List<Messaging.SingleEmailMessage> emailsToSend = new List<Messaging.SingleEmailMessage>();
        
        // We use this map to track which email belongs to which invoice 
        // so we can check if it sent successfully later.
        Map<Integer, Invoice__c> emailIndexToInvoiceMap = new Map<Integer, Invoice__c>();
        Integer emailIndex = 0;

        for (Invoice__c inv : invoices) {
            if (pdfMap.containsKey(inv.Id) && String.isNotBlank(inv.Account__r.Billing_Email__c)) {
                
                Messaging.SingleEmailMessage email = new Messaging.SingleEmailMessage();
                
                email.setToAddresses(new List<String>{ inv.Account__r.Billing_Email__c });
                email.setReplyTo('sagar.patil@praxiomai.com'); 
                email.setSenderDisplayName('Praxiom Billing Department');
                email.setSubject('Invoice ' + inv.Name + ' from Praxiom');
                
                String body = 'Dear ' + inv.Account__r.Name + ' Billing Team,\n\n';
                body += 'Please find attached your latest invoice (' + inv.Name + ') for the recent billing period.\n\n';
                if(inv.Due_Date__c != null) {
                    body += 'Payment is due by ' + inv.Due_Date__c.format() + '.\n\n';
                }
                body += 'If you have any questions, please reply to this email.\n\n';
                body += 'Thank you for your business!\n\nSagar Patil\nPraxiom';
                email.setPlainTextBody(body);
                
                Messaging.EmailFileAttachment efa = new Messaging.EmailFileAttachment();
                efa.setFileName('Invoice_' + inv.Name + '.pdf');
                efa.setBody(pdfMap.get(inv.Id));
                efa.setContentType('application/pdf');
                email.setFileAttachments(new List<Messaging.EmailFileAttachment>{efa});
                
                emailsToSend.add(email);
                emailIndexToInvoiceMap.put(emailIndex, inv);
                emailIndex++;
            } else {
                System.debug(LoggingLevel.WARN, 'Skipped emailing Invoice ' + inv.Name + '. Missing PDF or Billing Email.');
            }
        }

        if (emailsToSend.isEmpty()) return;

        // 🚀 FIRE EMAILS (false = allow partial success)
        Messaging.SendEmailResult[] emailResults = Messaging.sendEmail(emailsToSend, false);
        List<Invoice__c> invoicesToUpdate = new List<Invoice__c>();

        // 🛡️ Verify Success: Only update the invoice to "Sent" if the email actually went out
        for (Integer i = 0; i < emailResults.size(); i++) {
            Invoice__c relatedInvoice = emailIndexToInvoiceMap.get(i);
            
            if (emailResults[i].isSuccess()) {
                invoicesToUpdate.add(new Invoice__c(Id = relatedInvoice.Id, Status__c = 'Sent'));
            } else {
                String errorMsg = emailResults[i].getErrors()[0].getMessage();
                System.debug(LoggingLevel.ERROR, 'Failed to send email for Invoice ' + relatedInvoice.Name + ': ' + errorMsg);
            }
        }

        if (!invoicesToUpdate.isEmpty()) {
            update invoicesToUpdate;
        }
    }
}