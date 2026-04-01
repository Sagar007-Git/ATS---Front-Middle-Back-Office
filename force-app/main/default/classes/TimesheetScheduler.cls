public class TimesheetScheduler implements Schedulable {
    
    public void execute(SchedulableContext sc) {
        // Instantiate and fire the Batch Job at a safe limit of 200 records at a time
        TimesheetGenerationBatch batchJob = new TimesheetGenerationBatch();
        Database.executeBatch(batchJob, 200);
    }
}