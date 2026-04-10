import { LightningElement, api, track } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { NavigationMixin } from 'lightning/navigation'; 
import getActiveEntities from '@salesforce/apex/InvoiceConsoleController.getActiveEntities';

export default class InvoiceEntityDashboard extends NavigationMixin(LightningElement) {
    @api entityType;       // 'Account', 'Project', 'Task', or 'Candidate'
    @api pendingData = []; // Passed down from the Parent Hub
    @api searchTerm = '';  // Passed down from the Parent Hub's debounced search

    @track allActiveData = [];
    @track isDirectoryLoading = true; 

    // Columns for Section 1 (Pending)
    pendingColumns = [
        { label: 'Name', fieldName: 'name', type: 'text' },
        // ✅ Changed "Pending Timesheets" to "Unbilled Entries"
        { label: 'Unbilled Entries', fieldName: 'count', type: 'number', cellAttributes: { alignment: 'left' } },
        { type: 'button', typeAttributes: { label: 'Review & Invoice', name: 'review', variant: 'brand' } }
    ];

    // Columns for Section 2 (All Active)
    activeColumns = [
        { label: 'Name', fieldName: 'entityName', type: 'text' },
        { label: 'Status', fieldName: 'status', type: 'text' },
        { type: 'button', typeAttributes: { label: 'View Record', name: 'view', variant: 'base' } }
    ];

    connectedCallback() {
        this.fetchActiveDirectory();
    }

    // ==========================================
    // DATA FETCHING & FILTERING
    // ==========================================
    fetchActiveDirectory() {
        this.isDirectoryLoading = true;

        getActiveEntities({ entityType: this.entityType })
            .then(result => {
                this.allActiveData = result || [];
            })
            .catch(error => {
                this.showToast('Directory Error', this.extractErrorMessage(error), 'error');
            })
            .finally(() => {
                this.isDirectoryLoading = false;
            });
    }

    get filteredActiveData() {
        if (!this.searchTerm) {
            return this.allActiveData;
        }
        
        return this.allActiveData.filter(record => 
            record.entityName && record.entityName.toLowerCase().includes(this.searchTerm)
        );
    }

    get hasActiveData() {
        return this.filteredActiveData && this.filteredActiveData.length > 0;
    }

    get hasPendingData() {
        return this.pendingData && this.pendingData.length > 0;
    }

    // ==========================================
    // ACTION HANDLERS (Modularized)
    // ==========================================
    
    // Handles clicks in Section 1 (Pending Invoices)
    // Inside invoiceEntityDashboard.js
    handlePendingAction(event) {
        const actionName = event.detail.action.name;
        const selectedRow = event.detail.row;

        if (actionName === 'review') {
            this.dispatchEvent(new CustomEvent('drilldown', {
                detail: { 
                    entityId: selectedRow.id, 
                    entityName: selectedRow.name, 
                    records: selectedRow.records // ✅ Changed from timesheets to records
                }
            }));
        }
    }

    // Handles clicks in Section 2 (Active Directory)
    handleDirectoryAction(event) {
        const actionName = event.detail.action.name;
        const selectedRow = event.detail.row;

        if (actionName === 'view') {
            // Standard Salesforce navigation to open the actual record page
            this[NavigationMixin.Navigate]({
                type: 'standard__recordPage',
                attributes: {
                    recordId: selectedRow.entityId,
                    actionName: 'view'
                }
            });
        }
    }

    // ==========================================
    // UTILITIES
    // ==========================================
    extractErrorMessage(error) {
        if (error && error.body && error.body.message) return error.body.message;
        if (error && error.message) return error.message;
        return 'An unexpected error occurred.';
    }

    showToast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}