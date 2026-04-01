public with sharing class TimesheetGenerationService {

    // CONSTANTS: Defining picklist values safely
    public static final String FREQ_WEEKLY = 'Weekly';
    public static final String FREQ_BIWEEKLY = 'Bi-Weekly';
    public static final String FREQ_MONTHLY = 'Monthly';
    public static final String STATUS_DRAFT = 'Draft';

    /**
     * CORE METHOD: Generates generic Timesheets based on the Project Resource
     */
    public static void generateTimesheets(List<Project_Resource__c> resources) {
        List<Timesheet__c> timesheetsToInsert = new List<Timesheet__c>();
        List<Project_Resource__c> resourcesToUpdate = new List<Project_Resource__c>();

        for (Project_Resource__c pr : resources) {
            // 1. Logic to align the dates
            String preferredStartDay = (pr.Placement__r != null && String.isNotBlank(pr.Placement__r.Timesheet_Start_Day__c)) 
                                        ? pr.Placement__r.Timesheet_Start_Day__c : 'Monday';

            Date periodStartDate = alignToStartDay(pr.Next_Timesheet_Date__c, preferredStartDay, pr.Start_Date__c);
            Date periodEndDate = calculateEndDate(periodStartDate, pr.Timesheet_Frequency__c, pr.End_Date__c);

            // 2. Map fields to the Timesheet Header
            // Using Candidate_Employee__c as per your field list
            Timesheet__c newTs = new Timesheet__c(
                Project_Resource__c = pr.Id,
                Client__c = pr.Account__c, // Stamping Account directly
                Placement__c = pr.Placement__c,
                Candidate__c = pr.Candidate_Employee__c, 
                Start_Date__c = periodStartDate,
                End_Date__c = periodEndDate,
                Status__c = STATUS_DRAFT,
                Is_Auto_Generated__c = true
            );
            timesheetsToInsert.add(newTs);

            // 3. Increment the Next Due Date
            resourcesToUpdate.add(new Project_Resource__c(
                Id = pr.Id,
                Next_Timesheet_Date__c = calculateNextDueDate(pr.Next_Timesheet_Date__c, pr.Timesheet_Frequency__c)
            ));
        }

        if (!timesheetsToInsert.isEmpty()) {
            insert timesheetsToInsert;
        }
        
        if (!resourcesToUpdate.isEmpty()) {
            update resourcesToUpdate;
        }
    }
    /**
     * HELPER 1: SMART ALIGNMENT - Aligns start date to Client's requested Day of the Week
     */
    private static Date alignToStartDay(Date nextTimesheetDate, String dayName, Date assignmentStartDate) {
        Map<String, Integer> dayMap = new Map<String, Integer>{
            'Sunday' => 0, 'Monday' => 1, 'Tuesday' => 2, 'Wednesday' => 3, 
            'Thursday' => 4, 'Friday' => 5, 'Saturday' => 6
        };
        Integer targetDayInt = dayMap.containsKey(dayName) ? dayMap.get(dayName) : 1; 
        
        Date baseStart = nextTimesheetDate.addDays(-7);
        Date knownSunday = Date.newInstance(1900, 1, 7);
        Integer baseStartDayInt = Math.mod(knownSunday.daysBetween(baseStart), 7);
        Integer diff = Math.mod((baseStartDayInt - targetDayInt + 7), 7);
        Date alignedStart = baseStart.addDays(-diff);

        if (assignmentStartDate != null && alignedStart < assignmentStartDate) {
            return assignmentStartDate;
        }
        return alignedStart;
    }

    /**
     * HELPER 2: Calculates the Period End Date
     */
    private static Date calculateEndDate(Date periodStartDate, String frequency, Date assignmentEndDate) {
        Date calculatedEnd;

        if (frequency == FREQ_WEEKLY) {
            calculatedEnd = periodStartDate.addDays(6);
        } else if (frequency == FREQ_BIWEEKLY) {
            calculatedEnd = periodStartDate.addDays(13);
        } else if (frequency == FREQ_MONTHLY) {
            calculatedEnd = periodStartDate.addMonths(1).addDays(-1); 
        } else {
            calculatedEnd = periodStartDate.addDays(6); 
        }

        if (assignmentEndDate != null && calculatedEnd > assignmentEndDate) {
            return assignmentEndDate;
        }
        return calculatedEnd;
    }

    /**
     * HELPER 3: Advances the Due Date for the Scheduler
     */
    private static Date calculateNextDueDate(Date currentDueDate, String frequency) {
        if (frequency == FREQ_WEEKLY) {
            return currentDueDate.addDays(7);
        } else if (frequency == FREQ_BIWEEKLY) {
            return currentDueDate.addDays(14);
        } else if (frequency == FREQ_MONTHLY) {
            return currentDueDate.addMonths(1);
        }
        return currentDueDate.addDays(7); 
    }
}