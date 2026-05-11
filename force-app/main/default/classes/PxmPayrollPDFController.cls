public class PxmPayrollPDFController {
    
    // Properties matching your Payroll Visualforce page
    public String agencyName { get; set; }
    public String agencyAddress { get; set; }
    public String payrollNumber { get; set; }
    public String payrollDate { get; set; }
    
    public String candidateName { get; set; }
    public String candidateEmail { get; set; }
    
    public Decimal grandTotalAmount { get; set; }
    public List<ProjectWrapper> projectWrappers { get; set; }

    // Nested Wrapper for Grouping by Project
    public class ProjectWrapper {
        public Id projectId { get; set; }
        public String projectName { get; set; }
        public Decimal projectTotalHours { get; set; }
        public Decimal projectTotalAmount { get; set; }
        public List<Time_Entry__c> timesheets { get; set; }

        public ProjectWrapper() {
            this.projectTotalHours = 0.0;
            this.projectTotalAmount = 0.0;
            this.timesheets = new List<Time_Entry__c>();
        }
    }

    public PxmPayrollPDFController() {
        projectWrappers = new List<ProjectWrapper>();
        grandTotalAmount = 0.0;

        String candIdStr = ApexPages.currentPage().getParameters().get('candId');
        String startDateStr = ApexPages.currentPage().getParameters().get('startDate');
        String endDateStr = ApexPages.currentPage().getParameters().get('endDate');

        if (String.isBlank(candIdStr) || String.isBlank(startDateStr) || String.isBlank(endDateStr)) return;

        try {
            Id candId = (Id)candIdStr;
            Date startDate = Date.valueOf(startDateStr.left(10));
            Date endDate = Date.valueOf(endDateStr.left(10));

            // 1. Fetch Candidate Info
            Contact candidate = [SELECT Name, Email FROM Contact WHERE Id = :candId LIMIT 1];
            candidateName = candidate.Name;
            candidateEmail = String.isNotBlank(candidate.Email) ? candidate.Email : 'No Email on File';

            // 2. Set Agency & Payroll Metadata
            agencyName = 'Enterprise Staffing LLC';
            agencyAddress = '100 Tech Parkway<br/>Suite 400<br/>San Francisco, CA 94105';
            payrollDate = Date.today().format();
            
            Integer yr = endDate.year();
            Integer mo = endDate.month();
            payrollNumber = 'PAY-' + candidateName.substring(0, Math.min(3, candidateName.length())).toUpperCase() + '-' + yr + '-' + String.valueOf(mo).leftPad(2, '0');

            // 3. Group Time Entries by Project
            Map<Id, ProjectWrapper> projMap = new Map<Id, ProjectWrapper>();
            List<Time_Entry__c> timeEntries = [
                SELECT Id, Date__c, Hours_Worked_Number_Format__c, 
                       Project__c, Project__r.Name, 
                       Task__r.Name, Project_Resource__r.Pay_Rate__c
                FROM Time_Entry__c
                WHERE Contact__c = :candId AND Date__c >= :startDate AND Date__c <= :endDate
                  AND Time_Status__c = 'Approved'
                ORDER BY Date__c ASC
            ];

            for (Time_Entry__c te : timeEntries) {
                if (!projMap.containsKey(te.Project__c)) {
                    ProjectWrapper pw = new ProjectWrapper();
                    pw.projectId = te.Project__c;
                    pw.projectName = te.Project__r.Name;
                    projMap.put(te.Project__c, pw);
                }
                
                ProjectWrapper pw = projMap.get(te.Project__c);
                pw.timesheets.add(te);

                Decimal hours = te.Hours_Worked_Number_Format__c != null ? te.Hours_Worked_Number_Format__c : 0;
                Decimal payRate = te.Project_Resource__r != null && te.Project_Resource__r.Pay_Rate__c != null ? te.Project_Resource__r.Pay_Rate__c : 0;

                pw.projectTotalHours += hours;
                Decimal lineAmount = hours * payRate;
                pw.projectTotalAmount += lineAmount;
                grandTotalAmount += lineAmount;
            }

            projectWrappers = projMap.values();

        } catch(Exception e) {
            System.debug('Payroll PDF Error: ' + e.getMessage());
        }
    }
}