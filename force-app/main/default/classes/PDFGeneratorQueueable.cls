public class PDFGeneratorQueueable implements Queueable, Database.AllowsCallouts {
    
    private Map<Id, String> recordIdToFileNameMap;
    private String vfPageName;
    private List<Id> allRecordIds;

    // Constructor: Accepts a Map of <RecordId, DesiredFileName> and the target VF Page
    public PDFGeneratorQueueable(Map<Id, String> recordIdToFileNameMap, String vfPageName) {
        this.recordIdToFileNameMap = recordIdToFileNameMap;
        this.vfPageName = vfPageName;
        this.allRecordIds = new List<Id>(recordIdToFileNameMap.keySet());
    }

    public void execute(QueueableContext context) {
        if (allRecordIds == null || allRecordIds.isEmpty()) return;

        // 🛡️ SCALABILITY FIX: Process max 10 records per chunk to avoid CPU/Callout Limits
        Integer batchSize = Math.min(allRecordIds.size(), 10);
        List<Id> processNow = new List<Id>();
        List<Id> processLater = new List<Id>();

        for (Integer i = 0; i < allRecordIds.size(); i++) {
            if (i < batchSize) {
                processNow.add(allRecordIds[i]);
            } else {
                processLater.add(allRecordIds[i]);
            }
        }

        try {
            // Step 1: Generate and Save the PDFs
            generateAndSavePdfs(processNow);
        } catch (Exception e) {
            System.debug(LoggingLevel.ERROR, 'Fatal Error in PDF Generator Queueable: ' + e.getMessage() + '\n' + e.getStackTraceString());
        }

        // Step 2: Chain the job if there are hundreds of records left!
        if (!processLater.isEmpty()) {
            // Remove the ones we just processed from the map to pass to the next job
            for(Id idToRemove : processNow) {
                recordIdToFileNameMap.remove(idToRemove);
            }
            System.enqueueJob(new PDFGeneratorQueueable(recordIdToFileNameMap, vfPageName));
        }
    }

    // =========================================================================
    // HELPER: GENERATE & ATTACH PDFs
    // =========================================================================
    private void generateAndSavePdfs(List<Id> processNow) {
        List<ContentVersion> cvsToInsert = new List<ContentVersion>();

        for (Id recId : processNow) {
            String fileName = recordIdToFileNameMap.get(recId);
            
            // Format: /apex/YourVFPageName?id=xxx
            PageReference pdfPage = new PageReference('/apex/' + vfPageName + '?id=' + recId);
            Blob pdfBlob;
            
            try {
                pdfBlob = Test.isRunningTest() ? Blob.valueOf('Test PDF') : pdfPage.getContentAsPDF();
                
                // 🚀 OPTIMIZATION: Using FirstPublishLocationId automatically links the file to the record!
                // No need for a separate ContentDocumentLink insert.
                cvsToInsert.add(new ContentVersion(
                    Title = fileName,
                    PathOnClient = fileName + '.pdf',
                    VersionData = pdfBlob,
                    IsMajorVersion = true,
                    FirstPublishLocationId = recId 
                ));
            } catch (Exception e) {
                // If one PDF fails, we catch it here so the other 9 in the batch still process!
                System.debug(LoggingLevel.ERROR, 'Failed to generate PDF for record ' + recId + ': ' + e.getMessage());
            }
        }

        // Execute DML safely
        if (!cvsToInsert.isEmpty()) {
            insert cvsToInsert;
        }
    }
}