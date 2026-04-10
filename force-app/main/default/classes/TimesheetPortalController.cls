public with sharing class TimesheetPortalController {

    // ─────────────────────────────────────────────────────────────────────────
    //  UTILITY: Centralized Error Handling
    // ─────────────────────────────────────────────────────────────────────────
    private static AuraHandledException handleException(String customMessage, Exception e) {
        // Extract the exact Salesforce system error
        String realError = e != null ? e.getMessage() : 'Unknown error';
        String logMessage = customMessage + ' | ' + realError;
        System.debug(LoggingLevel.ERROR, logMessage);
        
        // Pass the REAL error to the LWC Toast message instead of the generic one
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
            SELECT Id, Name, Project__c 
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
                   Project__c, Project_Resource__c, Shift_Type__c, Additional_Comments__c,
                   Approval_Status__c, Time_Status__c, Break_Time__c
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
                   // ✅ FIX: Added ContentDocumentId so the front end can open it
                   (SELECT ContentDocumentId, ContentDocument.Title, ContentDocument.FileExtension 
                    FROM ContentDocumentLinks 
                    ORDER BY SystemModstamp DESC LIMIT 1)
            FROM Expense__c
            WHERE Contact__c = :contactId
            WITH SECURITY_ENFORCED
            ORDER BY Expense_Date__c DESC NULLS LAST
        ];
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
    public static String saveTimeEntry(
        String contactId, String projectResourceId, String projectId, 
        String shiftType, String entryDate, Integer startHour, Integer startMinute, 
        Integer endHour, Integer endMinute, Decimal breakTime, String comments, String existingId
    ) {
        if (!isValidSfId(contactId) || !isValidSfId(projectResourceId)) {
            throw handleException('Invalid Contact or Project Resource ID.', null);
        }

        // Auto-lookup Project ID if missing
        if (!isValidSfId(projectId)) {
            try {
                Project_Resource__c pr = [SELECT Project__c FROM Project_Resource__c WHERE Id = :projectResourceId WITH SECURITY_ENFORCED LIMIT 1];
                projectId = pr.Project__c;
            } catch (Exception e) {
                throw handleException('Could not resolve Project ID from Resource.', e);
            }
        }

        Time_Entry__c entry;
        try {
            if (isValidSfId(existingId)) {
                entry = [SELECT Id, Start_Time__c, End_Time__c FROM Time_Entry__c WHERE Id = :existingId WITH SECURITY_ENFORCED LIMIT 1];
            } else {
                entry = new Time_Entry__c(Contact__c = contactId, Time_Status__c = 'Draft');
            }

            entry.Project_Resource__c    = projectResourceId;
            entry.Project__c             = projectId;
            entry.Shift_Type__c          = String.isNotBlank(shiftType) ? shiftType : 'Regular';
            entry.Date__c                = Date.valueOf(entryDate);
            entry.Break_Time__c          = breakTime != null ? breakTime : 0;
            entry.Additional_Comments__c = comments;

            if (startHour != null) entry.Start_Time__c = Time.newInstance(startHour, startMinute != null ? startMinute : 0, 0, 0);
            if (endHour != null) entry.End_Time__c = Time.newInstance(endHour, endMinute != null ? endMinute : 0, 0, 0);

            if (entry.Start_Time__c != null && entry.End_Time__c != null) {
                entry.Hours_Worked_Number_Format__c = calculateHours(entry.Start_Time__c, entry.End_Time__c, entry.Break_Time__c);
            }

            upsert as user entry;
            return entry.Id;
            
        } catch (DmlException e) {
            throw handleException('Failed to save Time Entry (DML Error).', e);
        } catch (Exception e) {
            throw handleException('Unexpected error saving Time Entry.', e);
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
            Time_Entry__c entry = [
                SELECT Id, Start_Time__c, End_Time__c, Break_Time__c 
                FROM Time_Entry__c WHERE Id = :entryId WITH SECURITY_ENFORCED LIMIT 1
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

            update as user entry;
            
        } catch (Exception e) {
            throw handleException('Failed to move time entry.', e);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  DELETE TIME ENTRY
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static void deleteTimeEntry(String entryId) {
        if (!isValidSfId(entryId)) throw handleException('Invalid Time Entry ID for deletion.', null);
        try {
            delete as user [SELECT Id FROM Time_Entry__c WHERE Id = :entryId LIMIT 1];
        } catch (Exception e) {
            throw handleException('Failed to delete time entry.', e);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  SUBMIT WEEK – Change Draft → Submitted
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static Integer submitWeek(String contactId, String weekStart, String weekEnd) {
        if (!isValidSfId(contactId)) throw handleException('Invalid Contact ID for submission.', null);

        try {
            // Safer Date parsing relying on native Date.valueOf ('YYYY-MM-DD')
            Date startDate = Date.valueOf(weekStart);
            Date endDate = Date.valueOf(weekEnd);

            List<Time_Entry__c> drafts = [
                SELECT Id, Time_Status__c FROM Time_Entry__c
                WHERE Contact__c = :contactId AND Date__c >= :startDate AND Date__c <= :endDate AND Time_Status__c = 'Draft'
                WITH SECURITY_ENFORCED
            ];
            
            for (Time_Entry__c e : drafts) {
                e.Time_Status__c = 'Submitted';
            }
            
            if (!drafts.isEmpty()) {
                update as user drafts;
            }
            return drafts.size();
            
        } catch (Exception e) {
            throw handleException('Failed to submit weekly timesheet.', e);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  SAVE / UPDATE EXPENSE
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static String saveExpense(
        String contactId, String projectId, String expenseDate, Decimal amount, 
        String category, String description, String comments, String existingId,
        String fileName, String base64Data
    ) {
        if (!isValidSfId(contactId) || !isValidSfId(projectId)) {
            throw handleException('Invalid ID parameters for expense.', null);
        }

        try {
            Expense__c expense;
            if (String.isNotBlank(existingId) && isValidSfId(existingId)) {
                // Fetch existing
                expense = [SELECT Id FROM Expense__c WHERE Id = :existingId LIMIT 1];
            } else {
                // Create new
                expense = new Expense__c(Contact__c = contactId);
                // We let Salesforce assign the default 'Draft' status automatically
                // to avoid Field-Level-Security lockouts.
            }

            // Assign fields
            expense.Project__c      = projectId;
            expense.Expense_Date__c = Date.valueOf(expenseDate);
            expense.Amount__c       = amount;
            expense.Category__c     = category;
            expense.Description__c  = description;
            expense.Comments__c     = comments;

            // ✅ FIX: Removed "as user" to prevent strict permission crashes
            upsert expense;

            // ✅ Handle File Attachment if a file was uploaded
            if (String.isNotBlank(base64Data) && String.isNotBlank(fileName)) {
                ContentVersion cv = new ContentVersion();
                cv.Title = fileName;
                cv.PathOnClient = fileName;
                cv.VersionData = EncodingUtil.base64Decode(base64Data);
                cv.IsMajorVersion = true;
                insert cv; // ✅ Removed "as user" here too

                Id conDocId = [SELECT ContentDocumentId FROM ContentVersion WHERE Id = :cv.Id].ContentDocumentId;

                ContentDocumentLink cdl = new ContentDocumentLink();
                cdl.LinkedEntityId = expense.Id;
                cdl.ContentDocumentId = conDocId;
                cdl.ShareType = 'V'; 
                insert cdl;
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
            delete as user [SELECT Id FROM Expense__c WHERE Id = :expenseId LIMIT 1];
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
            // Find the link between the expense and the file
            List<ContentDocumentLink> links = [
                SELECT ContentDocumentId 
                FROM ContentDocumentLink 
                WHERE LinkedEntityId = :expenseId
                WITH SECURITY_ENFORCED
            ];
            
            if (!links.isEmpty()) {
                Set<Id> docIds = new Set<Id>();
                for(ContentDocumentLink cdl : links) {
                    docIds.add(cdl.ContentDocumentId);
                }
                
                // Physically deleting the ContentDocument removes it from the record and the Org entirely
                delete as user [SELECT Id FROM ContentDocument WHERE Id IN :docIds];
            }
        } catch (Exception e) {
            throw handleException('Failed to delete attachment from org.', e);
        }
    }
}