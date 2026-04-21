    import { LightningElement, track } from 'lwc';
    import { ShowToastEvent } from 'lightning/platformShowToastEvent';

    // ✅ IMPORTING THE NEW APEX METHODS
    import getUnbilledProjects from '@salesforce/apex/InvoiceConsoleController.getUnbilledProjects';
    import generateInvoices from '@salesforce/apex/InvoiceConsoleController.generateInvoices';
    import reviewRecords from '@salesforce/apex/InvoiceConsoleController.reviewRecords';

    export default class InvoiceManagerHub extends LightningElement {
        @track isLoading = true;
        @track allData = []; // The master, unfiltered list of unbilled projects
        
        // --- Search & Filter State ---
        @track searchTerm = '';
        @track appliedSearchTerm = '';
        searchTimeout;

        // --- Review & Reject State ---
        @track isRejectModalOpen = false;
        @track rejectReason = '';

        // --- Grouped Data for Tabs ---
        @track projectGroups = [];

        // --- Drill-Down (Popup) State ---
        @track isDrillDownMode = false;
        @track drillDownTitle = '';
        @track drillDownData = [];
        @track selectedRows = [];

        @track candidateGroups = [];

        // --- Datatable Configuration (Updated to reflect Project aggregates) ---
        projectColumns = [
            { label: 'Project Name', fieldName: 'projectName', type: 'text' },
            { label: 'Client', fieldName: 'accountName', type: 'text' },
            { label: 'Unbilled Entries', fieldName: 'unbilledTimeEntries', type: 'number', cellAttributes: { alignment: 'left' } },
            { label: 'Total Hours', fieldName: 'totalHours', type: 'number', cellAttributes: { alignment: 'left' } },
            { label: 'Total Expenses', fieldName: 'totalExpenses', type: 'currency', typeAttributes: { currencyCode: 'USD' }, cellAttributes: { class: 'slds-text-color_error' } }
        ];

        connectedCallback() {
            this.loadUnbilledData();
        }

        // ==========================================
        // 1. DATA FETCHING & INITIALIZATION
        // ==========================================
        loadUnbilledData() {
            this.isLoading = true;
            this.isDrillDownMode = false;
            this.selectedRows = [];

            getUnbilledProjects()
                .then(result => {
                    this.allData = result || [];
                    this.applySearchAndGroup(); 
                })
                .catch(error => {
                    this.showToast('Error Loading Data', this.extractErrorMessage(error), 'error');
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

            // Apply Search Term Filter across Project and Candidate names ONLY
            if (this.appliedSearchTerm) {
                dataToProcess = this.allData.filter(proj => {
                    const pName = proj.projectName ? proj.projectName.toLowerCase() : '';
                    const cName = proj.candidateName ? proj.candidateName.toLowerCase() : '';
                    
                    return pName.includes(this.appliedSearchTerm) || 
                           cName.includes(this.appliedSearchTerm);
                });
            }

            // Rebuild the Data Groups for the UI Tabs
            // ✅ DELETED the this.accountGroups mapping line
            
            this.projectGroups = this.groupData(dataToProcess, 'projectId', 'projectName');
            this.candidateGroups = this.groupData(dataToProcess, 'candidateId', 'candidateName');
        }
        
        groupData(dataList, keyField, nameField) {
        if (!dataList || dataList.length === 0) return [];
        const groups = {};
        
        dataList.forEach(item => {
            let key = item[keyField] || 'Unassigned';
            let name = item[nameField] || 'Unassigned';

            if (!groups[key]) {
                // ✅ Changed "timesheets" to "records"
                groups[key] = { id: key, name: name, count: 0, records: [] }; 
            }
            
            groups[key].count += (item.unbilledTimeEntries || 0);
            groups[key].records.push(item); // ✅ Changed "timesheets" to "records"
        });

        return Object.values(groups).sort((a, b) => a.name.localeCompare(b.name));
    }

        // ==========================================
        // 3. UI DRILL-DOWN & TABLE ACTIONS
        // ==========================================
        handleDrillDown(event) {
        this.drillDownTitle = event.detail.entityName;
        // ✅ It now expects "records"
        this.drillDownData = event.detail.records || []; 
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
        // 4. ACTION EXECUTIONS (Invoicing)
        // ==========================================
        handleGenerate() {
            if (this.selectedRows.length === 0) return;
            this.isLoading = true;
            
            // Extract the Project IDs from the selected rows
            const ids = [...new Set(this.selectedRows.map(row => row.projectId))];
            
            generateInvoices({ projectIds: ids })
                .then(message => {
                    this.showToast('Success', message, 'success');
                    // Automatically refetch data and close the drill-down view
                    this.loadUnbilledData(); 
                })
                .catch(error => {
                    this.showToast('Generation Failed', this.extractErrorMessage(error), 'error');
                    this.isLoading = false;
                });
        }

        // ==========================================
        // MANAGER REVIEW ACTIONS (Approve / Reject)
        // ==========================================
        handleApprove() {
            if (this.selectedRows.length === 0) return;
            this.isLoading = true;
            
            const keys = this.selectedRows.map(row => row.compositeKey);
            
            reviewRecords({ compositeKeys: keys, newStatus: 'Approved', rejectReason: '' })
                .then(message => {
                    this.showToast('Success', message, 'success');
                    this.loadUnbilledData(); // Refresh the hub
                })
                .catch(error => {
                    this.showToast('Approval Failed', this.extractErrorMessage(error), 'error');
                    this.isLoading = false;
                });
        }

        openRejectModal() {
            if (this.selectedRows.length === 0) return;
            this.rejectReason = '';
            this.isRejectModalOpen = true;
        }

        closeRejectModal() {
            this.isRejectModalOpen = false;
        }

        handleRejectReasonChange(event) {
            this.rejectReason = event.target.value;
        }

        confirmReject() {
            if (!this.rejectReason) {
                this.showToast('Required', 'Please provide a reason for rejecting the timesheet.', 'warning');
                return;
            }

            this.isLoading = true;
            this.isRejectModalOpen = false;
            
            const keys = this.selectedRows.map(row => row.compositeKey);
            
            reviewRecords({ compositeKeys: keys, newStatus: 'Rejected', rejectReason: this.rejectReason })
                .then(message => {
                    this.showToast('Timesheets Rejected', 'The records have been sent back to the employee(s) for correction.', 'info');
                    this.loadUnbilledData();
                })
                .catch(error => {
                    this.showToast('Rejection Failed', this.extractErrorMessage(error), 'error');
                    this.isLoading = false;
                });
        }

        // ==========================================
        // 5. UTILITIES & ERROR HANDLING
        // ==========================================
        get isGenerateDisabled() {
            return this.selectedRows.length === 0;
        }

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
                mode: variant === 'error' ? 'sticky' : 'dismissable'
            }));
        }
    }