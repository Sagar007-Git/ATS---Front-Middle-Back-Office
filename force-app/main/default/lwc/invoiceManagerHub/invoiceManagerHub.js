import { LightningElement, track } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';

// Importing from our fully bulletproofed controller
import getBillableTimesheets from '@salesforce/apex/InvoiceConsoleController.getBillableTimesheets';
import generateInvoices from '@salesforce/apex/InvoiceConsoleController.generateInvoices';

export default class InvoiceManagerHub extends LightningElement {
    @track isLoading = true;
    @track allData = []; // The master, unfiltered list of timesheets
    
    // --- Search & Filter State ---
    @track searchTerm = '';
    @track appliedSearchTerm = '';
    searchTimeout;

    // --- Grouped Data for Tabs ---
    @track accountGroups = [];
    @track projectGroups = [];
    @track candidateGroups = [];

    // --- Drill-Down (Popup) State ---
    @track isDrillDownMode = false;
    @track drillDownTitle = '';
    @track drillDownData = [];
    @track selectedRows = [];

    // --- Datatable Configuration ---
    timesheetColumns = [
        { label: 'Timesheet', fieldName: 'timesheetName', type: 'text', initialWidth: 120 },
        { label: 'Client', fieldName: 'accountName', type: 'text' },
        { label: 'Project', fieldName: 'projectName', type: 'text' },
        { label: 'Task', fieldName: 'taskName', type: 'text', cellAttributes: { class: 'slds-text-color_success' } },
        { label: 'Candidate', fieldName: 'candidateName', type: 'text' },
        { label: 'Reporting Week', fieldName: 'reportingWeek', type: 'text' },
        { label: 'Hours', fieldName: 'totalHours', type: 'number', cellAttributes: { alignment: 'left' } },
        { label: 'Expenses', fieldName: 'totalExpenses', type: 'currency', typeAttributes: { currencyCode: 'USD' }, cellAttributes: { class: 'slds-text-color_error' } },
        { label: 'Receipts?', fieldName: 'hasAttachments', type: 'boolean', cellAttributes: { alignment: 'center' } }
    ];

    connectedCallback() {
        this.loadTimesheets();
    }

    // ==========================================
    // 1. DATA FETCHING & INITIALIZATION
    // ==========================================
    loadTimesheets() {
        this.isLoading = true;
        this.isDrillDownMode = false;
        this.selectedRows = [];

        getBillableTimesheets()
            .then(result => {
                this.allData = result || [];
                this.applySearchAndGroup(); 
            })
            .catch(error => {
                this.showToast('Error Loading Timesheets', this.extractErrorMessage(error), 'error');
            })
            .finally(() => {
                this.isLoading = false;
            });
    }

    // ==========================================
    // 2. SEARCH & FILTERING ENGINE
    // ==========================================
    handleSearch(event) {
        this.searchTerm = event.target.value.toLowerCase();
        
        // Debounce logic to prevent UI lagging while typing
        clearTimeout(this.searchTimeout);
        this.searchTimeout = setTimeout(() => {
            this.appliedSearchTerm = this.searchTerm; 
            this.applySearchAndGroup();
        }, 300);
    }

    applySearchAndGroup() {
        let dataToProcess = this.allData;

        // Apply Search Term Filter across key fields
        if (this.appliedSearchTerm) {
            dataToProcess = this.allData.filter(ts => {
                const acc = ts.accountName ? ts.accountName.toLowerCase() : '';
                const proj = ts.projectName ? ts.projectName.toLowerCase() : '';
                const task = ts.taskName ? ts.taskName.toLowerCase() : ''; 
                const cand = ts.candidateName ? ts.candidateName.toLowerCase() : '';
                
                return acc.includes(this.appliedSearchTerm) || 
                       proj.includes(this.appliedSearchTerm) || 
                       task.includes(this.appliedSearchTerm) || 
                       cand.includes(this.appliedSearchTerm);
            });
        }

        // Rebuild the Data Groups for the UI Tabs
        this.accountGroups = this.groupData(dataToProcess, 'accountId', 'accountName');
        this.projectGroups = this.groupData(dataToProcess, 'projectId', 'projectName');
        this.candidateGroups = this.groupData(dataToProcess, 'candidateName', 'candidateName');
    }
    
    groupData(dataList, keyField, nameField) {
        if (!dataList || dataList.length === 0) return [];
        const groups = {};
        
        dataList.forEach(ts => {
            let key = ts[keyField] || 'Unassigned';
            let name = ts[nameField] || 'Unassigned';

            if (!groups[key]) {
                groups[key] = { id: key, name: name, count: 0, timesheets: [] };
            }
            groups[key].count++;
            groups[key].timesheets.push(ts);
        });

        // Alphabetical sort for a cleaner UI
        return Object.values(groups).sort((a, b) => a.name.localeCompare(b.name));
    }

    // ==========================================
    // 3. UI DRILL-DOWN & TABLE ACTIONS
    // ==========================================
    handleDrillDown(event) {
        this.drillDownTitle = event.detail.entityName;
        this.drillDownData = event.detail.timesheets;
        this.isDrillDownMode = true;
    }

    handleBack() {
        this.isDrillDownMode = false;
        this.selectedRows = [];
    }

    handleRowSelection(event) {
        this.selectedRows = event.detail.selectedRows;
    }

    // ==========================================
    // 4. INVOICE GENERATION EXECUTION
    // ==========================================
    handleGenerate() {
        if (this.selectedRows.length === 0) return;
        this.isLoading = true;
        
        // Extract the raw Ids to send to Apex
        const ids = this.selectedRows.map(row => row.timesheetId);
        
        generateInvoices({ timesheetIds: ids })
            .then(message => {
                this.showToast('Success', message, 'success');
                // Automatically refetch data and close the drill-down view
                this.loadTimesheets(); 
            })
            .catch(error => {
                this.showToast('Generation Failed', this.extractErrorMessage(error), 'error');
                this.isLoading = false;
            });
    }

    // ==========================================
    // 5. UTILITIES & ERROR HANDLING
    // ==========================================
    get isGenerateDisabled() {
        return this.selectedRows.length === 0;
    }

    /**
     * Extracts the deepest, most human-readable error from the Salesforce payload
     */
    extractErrorMessage(error) {
        if (error?.body?.message) {
            return error.body.message;
        } else if (error?.body?.pageErrors && error.body.pageErrors.length > 0) {
            return error.body.pageErrors[0].message;
        } else if (error?.message) {
            return error.message;
        } else if (typeof error === 'string') {
            return error;
        }
        return 'An unexpected system error occurred. Please try again.';
    }

    showToast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ 
            title: title, 
            message: message, 
            variant: variant,
            mode: variant === 'error' ? 'sticky' : 'dismissable' // Keep errors on screen until dismissed
        }));
    }
}