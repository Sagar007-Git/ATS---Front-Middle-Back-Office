// 🌟 MUST BE 'without sharing' FOR GUEST USERS ON SITES
public without sharing class TimesheetPortalController {

    // ─────────────────────────────────────────────────────────────────────────
    //  UTILITY: Centralized Error Handling
    // ─────────────────────────────────────────────────────────────────────────
    private static AuraHandledException handleException(String customMessage, Exception e) {
        String realError = e != null ? e.getMessage() : 'Unknown error';
        String logMessage = customMessage + ' | ' + realError;
        System.debug(LoggingLevel.ERROR, logMessage);
        
        AuraHandledException auraEx = new AuraHandledException(logMessage);
        auraEx.setMessage(logMessage); 
        return auraEx;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  UTILITY: Validate Salesforce ID format
    // ─────────────────────────────────────────────────────────────────────────
    private static Boolean isValidSfId(String id) {
        if (String.isBlank(id)) return false;
        id = id.trim();
        if (id.length() != 15 && id.length() != 18) return false;
        return id.isAlphanumeric();
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  UTILITY: Calculate hours worked from start/end times + break
    // ─────────────────────────────────────────────────────────────────────────
    private static Decimal calculateHours(Time startTime, Time endTime, Decimal breakHours) {
        if (startTime == null || endTime == null) return 0;
        
        Integer startMins = startTime.hour() * 60 + startTime.minute();
        Integer endMins = endTime.hour() * 60 + endTime.minute();
        
        Decimal hours = (endMins - startMins) / 60.0;
        
        // Handle overnight shifts (e.g., 22:00 → 02:00)
        if (hours < 0) hours += 24;
        
        // Subtract break time safely
        if (breakHours != null && breakHours > 0) {
            hours -= breakHours;
            if (hours < 0) hours = 0;
        }
        
        return hours.setScale(2, RoundingMode.HALF_UP);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  MAIN ENTRY POINT: Load All Data
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled(cacheable=true)
    public static Map<String, Object> getTimesheetData(String contactId) {
        if (!isValidSfId(contactId)) {
            throw handleException('Valid Contact ID is required.', null);
        }

        Map<String, Object> result = new Map<String, Object>();

        try {
            // 1. Fetch Project Resources
            List<Project_Resource__c> resources = fetchProjectResources(contactId);
            result.put('projectResources', resources);

            // 2. Fetch Project Tasks based on Resources
            Set<Id> projectIds = new Set<Id>();
            for (Project_Resource__c pr : resources) {
                if (pr.Project__c != null) projectIds.add(pr.Project__c);
            }
            result.put('projectTasks', fetchProjectTasks(projectIds));

            // 3. Fetch Time Entries (Rolling 90 days back, 60 days forward)
            Date rangeStart = Date.today().addDays(-90);
            Date rangeEnd   = Date.today().addDays(60);
            result.put('timeEntries', fetchTimeEntries(contactId, rangeStart, rangeEnd));

            // 4. Fetch Expenses
            result.put('expenses', fetchExpenses(contactId));

            // 5. Fetch Contact Info
            Contact contactRecord = fetchContact(contactId);
            if (contactRecord != null) {
                result.put('contact', contactRecord);
            }

            return result;
            
        } catch (Exception e) {
            throw handleException('Failed to load initial timesheet data.', e);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  PRIVATE DATA FETCHERS (Modularized Queries)
    // ─────────────────────────────────────────────────────────────────────────
    private static List<Project_Resource__c> fetchProjectResources(Id contactId) {
        return [
            SELECT Id, Name, Project__c, Project__r.Name, Resource_Type__c, Status__c,
                   Start_Date__c, End_Date__c, Bill_Rate__c, Pay_Rate__c, 
                   Timesheet_Frequency__c, prxm_Billing_Type__c
            FROM Project_Resource__c
            WHERE Candidate_Employee__c = :contactId
            AND Status__c NOT IN ('Inactive', 'Cancelled')
            WITH SECURITY_ENFORCED
            ORDER BY Project__r.Name ASC
        ];
    }

    private static List<Task__c> fetchProjectTasks(Set<Id> projectIds) {
        if (projectIds.isEmpty()) return new List<Task__c>();
        return [
            SELECT Id, Name, Project__c, Billable__c, Bill_Rate__c 
            FROM Task__c 
            WHERE Project__c IN :projectIds 
            WITH SECURITY_ENFORCED
            ORDER BY Name ASC
        ];
    }

    private static List<Time_Entry__c> fetchTimeEntries(Id contactId, Date startDate, Date endDate) {
        return [
            SELECT Id, Name, Date__c, Start_Time__c, End_Time__c,
                   Hours_Worked_Number_Format__c, Hours_Worked_Time_Format__c,
                   Project__c, Project_Resource__c, 
                   Task__c, Task__r.Name, 
                   Additional_Comments__c, Approval_Status__c, Time_Status__c, Break_Time__c
            FROM Time_Entry__c
            WHERE Contact__c = :contactId
            AND Date__c >= :startDate
            AND Date__c <= :endDate
            WITH SECURITY_ENFORCED
            ORDER BY Date__c ASC, Start_Time__c ASC NULLS LAST
        ];
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  PRIVATE DATA FETCHER: Expenses
    // ─────────────────────────────────────────────────────────────────────────
    private static List<Expense__c> fetchExpenses(Id contactId) {
        return [
            SELECT Id, Name, Expense_Date__c, Amount__c, Category__c,
                   Project__c, Project__r.Name, Description__c, Comments__c,
                   Status__c, Manager_Comments__c, Submitted_On__c,
                   (SELECT ContentDocumentId, ContentDocument.Title, ContentDocument.FileExtension, ContentDocument.ContentSize 
                    FROM ContentDocumentLinks 
                    ORDER BY SystemModstamp DESC LIMIT 1)
            FROM Expense__c
            WHERE Contact__c = :contactId
            WITH SECURITY_ENFORCED
            ORDER BY Expense_Date__c DESC NULLS LAST
        ];
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  FILE PREVIEW (Bypasses Site Guest User Servlet Restrictions)
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static Map<String, String> getFilePreviewData(String documentId) {
        try {
            ContentVersion cv = [SELECT Title, FileExtension, VersionData 
                                 FROM ContentVersion 
                                 WHERE ContentDocumentId = :documentId AND IsLatest = true LIMIT 1];

            String base64Data = EncodingUtil.base64Encode(cv.VersionData);
            
            String ext = cv.FileExtension != null ? cv.FileExtension.toLowerCase() : '';
            String mimeType = 'application/octet-stream';
            if (ext == 'pdf') mimeType = 'application/pdf';
            else if (ext == 'png') mimeType = 'image/png';
            else if (ext == 'jpg' || ext == 'jpeg') mimeType = 'image/jpeg';

            Map<String, String> result = new Map<String, String>();
            result.put('base64', 'data:' + mimeType + ';base64,' + base64Data);
            result.put('fileType', ext);
            result.put('title', cv.Title);
            
            return result;
        } catch (Exception e) {
            throw handleException('Failed to generate secure preview', e);
        }
    }

    private static Contact fetchContact(Id contactId) {
        List<Contact> contacts = [
            SELECT Id, Name, Title, Department 
            FROM Contact 
            WHERE Id = :contactId 
            WITH SECURITY_ENFORCED 
            LIMIT 1
        ];
        return contacts.isEmpty() ? null : contacts[0];
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  SAVE / UPDATE TIME ENTRY
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static String saveTimeEntry(String contactId, String projectResourceId, String projectId, String taskId, String entryDate, 
                                     Integer startHour, Integer startMinute, Integer endHour, Integer endMinute, 
                                     Decimal breakTime, String comments, String existingId) {
        try {
            Time_Entry__c entry = String.isNotBlank(existingId) ? 
                [SELECT Id FROM Time_Entry__c WHERE Id = :existingId LIMIT 1] : 
                new Time_Entry__c(Contact__c = contactId, Time_Status__c = 'Draft');
            
            entry.Project_Resource__c = projectResourceId;
            entry.Project__c = projectId;
            
            entry.Task__c = String.isNotBlank(taskId) ? taskId : null;
            
            entry.Date__c = Date.valueOf(entryDate);
            entry.Break_Time__c = breakTime != null ? breakTime : 0;
            entry.Additional_Comments__c = comments;
            entry.Start_Time__c = Time.newInstance(startHour, startMinute, 0, 0);
            entry.End_Time__c = Time.newInstance(endHour, endMinute, 0, 0);
            entry.Hours_Worked_Number_Format__c = calculateHours(entry.Start_Time__c, entry.End_Time__c, entry.Break_Time__c);

            upsert entry; // 🌟 No 'as user'
            return entry.Id;
        } catch (Exception e) { 
            throw handleException('Save failed', e); 
        }
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // 🛡️ ENTERPRISE SECURITY: LOCKDOWN HELPER
    // ─────────────────────────────────────────────────────────────────────────
    private static void enforceLockdownPolicy(String entryId) {
        if (String.isBlank(entryId)) return; 
        
        // 🌟 Stripped SECURITY_ENFORCED here so the system can verify it regardless of Guest permissions
        Time_Entry__c existing = [SELECT Time_Status__c FROM Time_Entry__c WHERE Id = :entryId LIMIT 1];
        
        if (existing.Time_Status__c == 'Submitted' || 
            existing.Time_Status__c == 'In Review' || 
            existing.Time_Status__c == 'Approved') {
            throw new AuraHandledException('Enterprise Security Failsafe: This entry is currently locked (' + existing.Time_Status__c + ') and cannot be modified.');
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  MOVE TIME ENTRY (Drag & Drop)
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static void moveTimeEntry(String entryId, String newProjectResourceId, String newProjectId, String newDate, Integer startHour, Integer startMinute) {
        if (!isValidSfId(entryId) || !isValidSfId(newProjectResourceId) || !isValidSfId(newProjectId)) {
            throw handleException('Invalid parameter IDs for moving entry.', null);
        }

        try {
            enforceLockdownPolicy(entryId);
            
            // 🌟 Stripped SECURITY_ENFORCED to guarantee the system can read it for the move calculation
            Time_Entry__c entry = [
                SELECT Id, Start_Time__c, End_Time__c, Break_Time__c 
                FROM Time_Entry__c WHERE Id = :entryId LIMIT 1
            ];

            // Preserve exact duration
            Integer durMins = 0;
            if (entry.Start_Time__c != null && entry.End_Time__c != null) {
                Integer sTotal = entry.Start_Time__c.hour() * 60 + entry.Start_Time__c.minute();
                Integer eTotal = entry.End_Time__c.hour() * 60 + entry.End_Time__c.minute();
                durMins = eTotal - sTotal;
                if (durMins < 0) durMins += 24 * 60; // Overnight duration
            }

            entry.Project_Resource__c = newProjectResourceId;
            entry.Project__c          = newProjectId;
            entry.Date__c             = Date.valueOf(newDate);
            entry.Start_Time__c       = Time.newInstance(startHour, startMinute != null ? startMinute : 0, 0, 0);

            // Recalculate End Time
            Integer newEndTotal = startHour * 60 + (startMinute != null ? startMinute : 0) + durMins;
            entry.End_Time__c = Time.newInstance(Math.mod(newEndTotal / 60, 24), Math.mod(newEndTotal, 60), 0, 0);

            if (entry.Start_Time__c != null && entry.End_Time__c != null) {
                entry.Hours_Worked_Number_Format__c = calculateHours(entry.Start_Time__c, entry.End_Time__c, entry.Break_Time__c);
            }

            // 🌟 THE BIG FIX: Removed 'as user' to prevent Guest User restriction crashes
            update entry; 
            
        } catch (Exception e) {
            throw new AuraHandledException(e.getMessage());
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  DELETE TIME ENTRY
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static void deleteTimeEntry(String entryId) {
        if (!isValidSfId(entryId)) throw handleException('Invalid Time Entry ID for deletion.', null);
        try {
            enforceLockdownPolicy(entryId);
            // 🌟 THE BIG FIX: Removed 'as user'
            delete [SELECT Id FROM Time_Entry__c WHERE Id = :entryId LIMIT 1];
        } catch (Exception e) {
            throw handleException('Failed to delete time entry.', e);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  SAVE / UPDATE EXPENSE
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static String saveExpense(
        String contactId, String projectId, String expenseDate, Decimal amount, 
        String category, String description, String comments, String existingId,
        String fileName, String base64Data, String status
    ) {
        if (!isValidSfId(contactId) || !isValidSfId(projectId)) {
            throw handleException('Invalid ID parameters for expense.', null);
        }

        try {
            Expense__c expense;
            if (String.isNotBlank(existingId) && isValidSfId(existingId)) {
                expense = [SELECT Id FROM Expense__c WHERE Id = :existingId LIMIT 1];
            } else {
                expense = new Expense__c(Contact__c = contactId);
            }

            expense.Project__c      = projectId;
            expense.Expense_Date__c = Date.valueOf(expenseDate);
            expense.Amount__c       = amount;
            expense.Category__c     = category;
            expense.Description__c  = description;
            expense.Comments__c     = comments;
            expense.Status__c       = status;

            upsert expense; // 🌟 No 'as user'

            if (String.isNotBlank(base64Data) && String.isNotBlank(fileName)) {
                ContentVersion cv = new ContentVersion();
                cv.Title = fileName;
                cv.PathOnClient = fileName;
                cv.VersionData = EncodingUtil.base64Decode(base64Data);
                cv.IsMajorVersion = true;
                insert cv; // 🌟 No 'as user'

                Id conDocId = [SELECT ContentDocumentId FROM ContentVersion WHERE Id = :cv.Id].ContentDocumentId;

                ContentDocumentLink cdl = new ContentDocumentLink();
                cdl.LinkedEntityId = expense.Id;
                cdl.ContentDocumentId = conDocId;
                cdl.ShareType = 'V'; 
                insert cdl; // 🌟 No 'as user'
            }

            return expense.Id;
            
        } catch (Exception e) {
            throw handleException('Failed to save expense record', e);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  DELETE EXPENSE
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static void deleteExpense(String expenseId) {
        if (!isValidSfId(expenseId)) throw handleException('Invalid Expense ID for deletion.', null);
        try {
            // 🌟 THE BIG FIX: Removed 'as user'
            delete [SELECT Id FROM Expense__c WHERE Id = :expenseId LIMIT 1];
        } catch (Exception e) {
            throw handleException('Failed to delete expense.', e);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  DELETE EXPENSE ATTACHMENT (Physical File Deletion)
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static void deleteExpenseAttachment(String expenseId) {
        if (!isValidSfId(expenseId)) {
            throw handleException('Invalid Expense ID for attachment deletion.', null);
        }
        try {
            // 🌟 Removed SECURITY_ENFORCED so the system can grab the links
            List<ContentDocumentLink> links = [
                SELECT ContentDocumentId 
                FROM ContentDocumentLink 
                WHERE LinkedEntityId = :expenseId
            ];
            
            if (!links.isEmpty()) {
                Set<Id> docIds = new Set<Id>();
                for(ContentDocumentLink cdl : links) {
                    docIds.add(cdl.ContentDocumentId);
                }
                
                // 🌟 THE BIG FIX: Removed 'as user' to allow system-level file deletion
                delete [SELECT Id FROM ContentDocument WHERE Id IN :docIds];
            }
        } catch (Exception e) {
            throw handleException('Failed to delete attachment from org.', e);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  BULK SUBMIT WEEK
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static Integer submitWeek(String contactId, String weekStart, String weekEnd) {
        try {
            Date sDate = Date.valueOf(weekStart);
            Date eDate = Date.valueOf(weekEnd);

            List<Time_Entry__c> entriesToSubmit = [
                SELECT Id, Time_Status__c 
                FROM Time_Entry__c 
                WHERE Contact__c = :contactId 
                AND Date__c >= :sDate AND Date__c <= :eDate
                AND Time_Status__c IN ('Draft', 'Rejected')
                WITH SECURITY_ENFORCED
            ];

            if (entriesToSubmit.isEmpty()) {
                return 0;
            }

            for (Time_Entry__c te : entriesToSubmit) {
                te.Time_Status__c = 'Submitted';
            }

            update entriesToSubmit; // 🌟 No 'as user'
            return entriesToSubmit.size();

        } catch (Exception e) {
            System.debug('SUBMIT WEEK ERROR: ' + e.getMessage());
            throw new AuraHandledException('Submission failed: ' + e.getMessage());
        }
    }
}