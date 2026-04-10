public class InvoiceDispatchQueueable implements Queueable, Database.AllowsCallouts {
    
    private List<Id> allInvoiceIds;

    public InvoiceDispatchQueueable(List<Id> invoiceIds) {
        this.allInvoiceIds = invoiceIds;
    }

    public void execute(QueueableContext context) {
        if (allInvoiceIds == null || allInvoiceIds.isEmpty()) return;

        Integer batchSize = Math.min(allInvoiceIds.size(), 5);
        List<Id> processNow = new List<Id>();
        List<Id> processLater = new List<Id>();

        for (Integer i = 0; i < allInvoiceIds.size(); i++) {
            if (i < batchSize) processNow.add(allInvoiceIds[i]);
            else processLater.add(allInvoiceIds[i]);
        }

        try {
            List<Invoice__c> invoicesToProcess = queryInvoices(processNow);
            System.debug('🔍 Queried ' + invoicesToProcess.size() + ' invoices');

            Map<Id, Blob> invoiceIdToPdfBlob = new Map<Id, Blob>();
            List<ContentVersion> cvsToInsert = generatePdfs(invoicesToProcess, invoiceIdToPdfBlob);
            
            if (!cvsToInsert.isEmpty()) {
                insert cvsToInsert;
                System.debug('💾 Inserted ' + cvsToInsert.size() + ' ContentVersion records');
            }

            sendEmailsAndUpdateStatus(invoicesToProcess, invoiceIdToPdfBlob);

        } catch (Exception e) {
            System.debug(LoggingLevel.ERROR, '❌ Fatal Error in Dispatch Queueable: ' + e.getMessage());
            System.debug(LoggingLevel.ERROR, 'Stack: ' + e.getStackTraceString());
            // Optional: throw e; to mark job as Failed
        }

        if (!processLater.isEmpty()) {
            System.enqueueJob(new InvoiceDispatchQueueable(processLater));
            System.debug('🔗 Enqueued next batch of ' + processLater.size() + ' invoices');
        }
    }

    private List<Invoice__c> queryInvoices(List<Id> invoiceIds) {
        return [
            SELECT Id, Name, Account__c, Account__r.Name, Account__r.Billing_Email__c,
                   Invoice_Date__c, Due_Date__c 
            FROM Invoice__c 
            WHERE Id IN :invoiceIds
        ];
    }

    private List<ContentVersion> generatePdfs(List<Invoice__c> invoices, Map<Id, Blob> pdfMap) {
        List<ContentVersion> filesToInsert = new List<ContentVersion>();
        
        for (Invoice__c inv : invoices) {
            try {
                PageReference pdfPage = new PageReference('/apex/PxmInvoicePDF?id=' + inv.Id);
                Blob pdfBlob = Test.isRunningTest() ? Blob.valueOf('Test PDF') : pdfPage.getContentAsPDF();
                
                System.debug('✅ PDF generated for ' + inv.Name + ', size: ' + pdfBlob.size());
                pdfMap.put(inv.Id, pdfBlob);
                
                String fileName = 'Invoice - ' + inv.Name + ' - ' + inv.Account__r.Name;
                filesToInsert.add(new ContentVersion(
                    Title = fileName,
                    PathOnClient = fileName + '.pdf',
                    VersionData = pdfBlob,
                    IsMajorVersion = true,
                    FirstPublishLocationId = inv.Id
                ));
            } catch (Exception e) {
                System.debug(LoggingLevel.ERROR, '🔴 PDF FAILED for Invoice ' + inv.Name + ': ' + e.getMessage());
            }
        }
        return filesToInsert;
    }

    private void sendEmailsAndUpdateStatus(List<Invoice__c> invoices, Map<Id, Blob> pdfMap) {
        List<Messaging.SingleEmailMessage> emailsToSend = new List<Messaging.SingleEmailMessage>();
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
                body += 'Please find attached your latest invoice (' + inv.Name + ').\n\n';
                if(inv.Due_Date__c != null) {
                    body += 'Payment is due by ' + inv.Due_Date__c.format() + '.\n\n';
                }
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
                
                System.debug('✉️ Email prepared for Invoice ' + inv.Name);
            } else {
                System.debug('⚠️ SKIPPED Invoice ' + inv.Name + ' (PDF: ' + pdfMap.containsKey(inv.Id) + ', Email: ' + String.isNotBlank(inv.Account__r.Billing_Email__c) + ')');
            }
        }

        if (emailsToSend.isEmpty()) {
            System.debug('⚠️ No emails to send in this batch');
            return;
        }

        Messaging.SendEmailResult[] emailResults = Messaging.sendEmail(emailsToSend, false);
        List<Invoice__c> invoicesToUpdate = new List<Invoice__c>();

        for (Integer i = 0; i < emailResults.size(); i++) {
            Invoice__c relatedInvoice = emailIndexToInvoiceMap.get(i);
            
            if (emailResults[i].isSuccess()) {
                invoicesToUpdate.add(new Invoice__c(Id = relatedInvoice.Id, Status__c = 'Sent'));
                System.debug('✅ Email SUCCESS for Invoice ' + relatedInvoice.Name);
            } else {
                String errorMsg = emailResults[i].getErrors()[0].getMessage();
                System.debug(LoggingLevel.ERROR, '🔴 EMAIL FAILED for Invoice ' + relatedInvoice.Name + ': ' + errorMsg);
            }
        }

        if (!invoicesToUpdate.isEmpty()) {
            update invoicesToUpdate;
            System.debug('🔄 Updated ' + invoicesToUpdate.size() + ' invoices to Status__c = Sent');
        }
    }
}