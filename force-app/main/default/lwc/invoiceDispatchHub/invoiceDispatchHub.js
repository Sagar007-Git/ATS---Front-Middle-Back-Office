import { LightningElement, track } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import getDraftInvoices from '@salesforce/apex/InvoiceConsoleController.getDraftInvoices';
import getTrackedInvoices from '@salesforce/apex/InvoiceConsoleController.getTrackedInvoices';
import dispatchInvoices from '@salesforce/apex/InvoiceConsoleController.dispatchInvoices';

export default class InvoiceDispatchHub extends NavigationMixin(LightningElement) {
    @track isLoading = true;

    // --- Draft (Tab 1) State ---
    @track allDraftData = [];
    @track filteredDraftData = [];
    @track selectedIds = [];

    // --- Tracked (Tab 2) State ---
    @track allTrackedData = [];
    @track filteredTrackedData = [];

    // --- Columns ---
    draftColumns = [
        { label: 'Invoice #', fieldName: 'Name', type: 'text', initialWidth: 150 },
        { label: 'Client', fieldName: 'clientName', type: 'text' },
        { label: 'Invoice Date', fieldName: 'Invoice_Date__c', type: 'date-local', initialWidth: 150 },
        { label: 'Due Date', fieldName: 'Due_Date__c', type: 'date-local', initialWidth: 150 },
        { label: 'Status', fieldName: 'Status__c', type: 'text', initialWidth: 120 }
    ];

    trackedColumns = [
        { label: 'Invoice #', fieldName: 'Name', type: 'text', initialWidth: 130 },
        { label: 'Client', fieldName: 'clientName', type: 'text' },
        { label: 'Invoice Date', fieldName: 'Invoice_Date__c', type: 'date-local', initialWidth: 120 },
        { label: 'Due Date', fieldName: 'Due_Date__c', type: 'date-local', initialWidth: 120 },
        { 
            label: 'Status', fieldName: 'Status__c', type: 'text', initialWidth: 120,
            cellAttributes: { 
                class: { fieldName: 'statusColor' } 
            }
        },
        { type: 'button', initialWidth: 150, typeAttributes: { label: 'View Record', name: 'view', variant: 'base' } }
    ];

    connectedCallback() {
        this.loadAllData();
    }

    // ==========================================
    // DATA FETCHING
    // ==========================================
    loadAllData() {
        this.isLoading = true;
        this.selectedIds = [];
        
        // Fetch both Drafts and Tracked invoices simultaneously
        Promise.all([getDraftInvoices(), getTrackedInvoices()])
            .then(results => {
                // Handle Drafts
                this.allDraftData = results[0].map(row => ({
                    ...row,
                    clientName: row.Account__r?.Name || 'Unknown Client'
                }));
                this.filteredDraftData = [...this.allDraftData];

                // Handle Tracked Invoices (Adds dynamic CSS colors for statuses)
                this.allTrackedData = results[1].map(row => {
                    let colorClass = 'slds-text-color_default';
                    if (row.Status__c === 'Paid') colorClass = 'slds-text-color_success';
                    if (row.Status__c === 'Overdue') colorClass = 'slds-text-color_error';
                    
                    return {
                        ...row,
                        clientName: row.Account__r?.Name || 'Unknown Client',
                        statusColor: colorClass
                    };
                });
                this.filteredTrackedData = [...this.allTrackedData];
            })
            .catch(error => {
                this.showToast('Error Loading Data', error.body?.message || error.message, 'error');
            })
            .finally(() => {
                this.isLoading = false;
            });
    }

    // ==========================================
    // SEARCH & FILTERING
    // ==========================================
    handleDraftSearch(event) {
        const term = event.target.value.toLowerCase();
        if (!term) {
            this.filteredDraftData = [...this.allDraftData];
        } else {
            this.filteredDraftData = this.allDraftData.filter(row => 
                row.clientName.toLowerCase().includes(term) || row.Name.toLowerCase().includes(term)
            );
        }
    }

    handleTrackedSearch(event) {
        const term = event.target.value.toLowerCase();
        if (!term) {
            this.filteredTrackedData = [...this.allTrackedData];
        } else {
            this.filteredTrackedData = this.allTrackedData.filter(row => 
                row.clientName.toLowerCase().includes(term) || 
                row.Name.toLowerCase().includes(term) ||
                row.Status__c.toLowerCase().includes(term)
            );
        }
    }

    // ==========================================
    // ACTIONS
    // ==========================================
    handleRowSelection(event) {
        this.selectedIds = event.detail.selectedRows.map(row => row.Id);
    }

    get isDispatchDisabled() {
        return this.selectedIds.length === 0;
    }

    handleDispatch() {
        this.isLoading = true;
        dispatchInvoices({ invoiceIds: this.selectedIds })
            .then(message => {
                this.showToast('Dispatch Started!', message, 'success');
                // The records are updating in the background. Reload data to move them from Tab 1 to Tab 2.
                setTimeout(() => { this.loadAllData(); }, 3000); 
            })
            .catch(error => {
                this.showToast('Dispatch Failed', error.body?.message || error.message, 'error');
                this.isLoading = false;
            });
    }

    handleRowAction(event) {
        const actionName = event.detail.action.name;
        const row = event.detail.row;

        if (actionName === 'view') {
            this[NavigationMixin.Navigate]({
                type: 'standard__recordPage',
                attributes: {
                    recordId: row.Id,
                    actionName: 'view'
                }
            });
        }
    }

    showToast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}