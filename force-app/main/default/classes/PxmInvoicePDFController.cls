public class PxmInvoicePDFController {
    
    // Properties matching your Visualforce page
    public String agencyName { get; set; }
    public String agencyAddress { get; set; }
    public String invoiceNumber { get; set; }
    public String invoiceDate { get; set; }
    public String paymentTerms { get; set; }
    public String dueDate { get; set; }
    
    public String clientName { get; set; }
    public String clientAddress { get; set; }
    
    public Decimal grandTotalAmount { get; set; }
    public List<ProjectWrapper> projectWrappers { get; set; }

    // Nested Wrapper for Grouping by Project
    public class ProjectWrapper {
        public Id projectId { get; set; }
        public String projectName { get; set; }
        public String poNumber { get; set; }
        public Decimal projectTotalHours { get; set; }
        public Decimal projectTotalAmount { get; set; }
        public List<Time_Entry__c> timesheets { get; set; }
        public List<Expense__c> expenses { get; set; }

        public ProjectWrapper() {
            this.projectTotalHours = 0.0;
            this.projectTotalAmount = 0.0;
            this.timesheets = new List<Time_Entry__c>();
            this.expenses = new List<Expense__c>();
        }
    }

    public PxmInvoicePDFController() {
        projectWrappers = new List<ProjectWrapper>();
        grandTotalAmount = 0.0;

        // Catch the parameters from the Batch or Preview Button
        String accIdStr = ApexPages.currentPage().getParameters().get('accId');
        String startDateStr = ApexPages.currentPage().getParameters().get('startDate');
        String endDateStr = ApexPages.currentPage().getParameters().get('endDate');

        if (String.isBlank(accIdStr) || String.isBlank(startDateStr) || String.isBlank(endDateStr)) return;

        try {
            Id accId = (Id)accIdStr;
            Date startDate = Date.valueOf(startDateStr.left(10));
            Date endDate = Date.valueOf(endDateStr.left(10));

            // 1. Fetch Client Info
            Account client = [SELECT Name, BillingStreet, BillingCity, BillingState, BillingPostalCode FROM Account WHERE Id = :accId LIMIT 1];
            clientName = client.Name;
            
            List<String> addrParts = new List<String>();
            if(String.isNotBlank(client.BillingStreet)) addrParts.add(client.BillingStreet);
            if(String.isNotBlank(client.BillingCity)) addrParts.add(client.BillingCity + ', ' + (client.BillingState != null ? client.BillingState : ''));
            if(String.isNotBlank(client.BillingPostalCode)) addrParts.add(client.BillingPostalCode);
            clientAddress = String.join(addrParts, '<br/>');

            // 2. Set Agency & Invoice Metadata
            agencyName = 'Enterprise Staffing LLC';
            agencyAddress = '100 Tech Parkway<br/>Suite 400<br/>San Francisco, CA 94105';
            invoiceDate = Date.today().format();
            paymentTerms = 'Net 30';
            dueDate = Date.today().addDays(30).format();
            
            Integer yr = endDate.year();
            Integer mo = endDate.month();
            invoiceNumber = 'INV-' + clientName.substring(0, Math.min(3, clientName.length())).toUpperCase() + '-' + yr + '-' + String.valueOf(mo).leftPad(2, '0');

            // 3. Group Time Entries
            Map<Id, ProjectWrapper> projMap = new Map<Id, ProjectWrapper>();
            List<Time_Entry__c> timeEntries = [
                SELECT Id, Date__c, Hours_Worked_Number_Format__c, Contact__r.Name,
                       Project__c, Project__r.Name, Project__r.PO_Number__c, Project__r.Bill_Rate__c,
                       Task__r.Name, Task__r.Bill_Rate__c
                FROM Time_Entry__c
                WHERE Project__r.Client__c = :accId AND Date__c >= :startDate AND Date__c <= :endDate
                  AND Time_Status__c = 'Approved' 
                ORDER BY Date__c ASC
            ];

            for (Time_Entry__c te : timeEntries) {
                if (!projMap.containsKey(te.Project__c)) {
                    ProjectWrapper pw = new ProjectWrapper();
                    pw.projectId = te.Project__c;
                    pw.projectName = te.Project__r.Name;
                    pw.poNumber = te.Project__r.PO_Number__c != null ? te.Project__r.PO_Number__c : 'PENDING';
                    projMap.put(te.Project__c, pw);
                }
                
                ProjectWrapper pw = projMap.get(te.Project__c);
                pw.timesheets.add(te);

                Decimal hours = te.Hours_Worked_Number_Format__c != null ? te.Hours_Worked_Number_Format__c : 0;
                Decimal rate = te.Task__r != null && te.Task__r.Bill_Rate__c != null ? te.Task__r.Bill_Rate__c : (te.Project__r.Bill_Rate__c != null ? te.Project__r.Bill_Rate__c : 0);

                pw.projectTotalHours += hours;
                Decimal lineAmount = hours * rate;
                pw.projectTotalAmount += lineAmount;
                grandTotalAmount += lineAmount;
            }

            // 4. Group Expenses
            List<Expense__c> expenses = [
                SELECT Id, Expense_Date__c, Amount__c, Category__c, Description__c, Contact__r.Name,
                       Project__c, Project__r.Name, Project__r.PO_Number__c
                FROM Expense__c
                WHERE Project__r.Client__c = :accId AND Expense_Date__c >= :startDate AND Expense_Date__c <= :endDate
                  AND Status__c = 'Approved'
                ORDER BY Expense_Date__c ASC
            ];

            for (Expense__c exp : expenses) {
                if (!projMap.containsKey(exp.Project__c)) {
                    ProjectWrapper pw = new ProjectWrapper();
                    pw.projectId = exp.Project__c;
                    pw.projectName = exp.Project__r.Name;
                    pw.poNumber = exp.Project__r.PO_Number__c != null ? exp.Project__r.PO_Number__c : 'PENDING';
                    projMap.put(exp.Project__c, pw);
                }
                
                ProjectWrapper pw = projMap.get(exp.Project__c);
                pw.expenses.add(exp);

                Decimal amt = exp.Amount__c != null ? exp.Amount__c : 0;
                pw.projectTotalAmount += amt;
                grandTotalAmount += amt;
            }

            projectWrappers = projMap.values();

        } catch(Exception e) {
            System.debug('PDF Error: ' + e.getMessage());
        }
    }
}