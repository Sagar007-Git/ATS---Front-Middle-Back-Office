import { LightningElement, track, wire } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import getApprovedTimesheets from '@salesforce/apex/BillingCommandCenterCtrl.getApprovedTimesheets';
import massGenerateTimesheetPDFs from '@salesforce/apex/BillingCommandCenterCtrl.massGenerateTimesheetPDFs';

export default class BillingCommandCenter extends LightningElement {
    @track allData = [];
    @track filteredData = [];
    @track selectedIds = [];
    @track isLoading = true;

    columns = [
        { label: 'Timesheet #', fieldName: 'Name', type: 'text', initialWidth: 130 },
        { label: 'Candidate', fieldName: 'candidateName', type: 'text' },
        { label: 'Client', fieldName: 'clientName', type: 'text' },
        { label: 'Start Date', fieldName: 'Start_Date__c', type: 'date-local' },
        { label: 'Total Hours', fieldName: 'Total_Time_Hours__c', type: 'number' }
    ];

    connectedCallback() {
        this.loadData();
    }

    loadData() {
        this.isLoading = true;
        getApprovedTimesheets()
            .then(result => {
                // Flatten the relationship fields for the datatable
                this.allData = result.map(row => ({
                    ...row,
                    candidateName: row.Project_Resource__r?.Candidate_Employee__r?.Name || 'Unknown',
                    clientName: row.Client__r?.Name || 'Unknown'
                }));
                this.filteredData = [...this.allData];
            })
            .catch(error => {
                this.showToast('Error Loading Data', error.body?.message || error.message, 'error');
            })
            .finally(() => {
                this.isLoading = false;
            });
    }

    handleSearch(event) {
        const term = event.target.value.toLowerCase();
        if (!term) {
            this.filteredData = [...this.allData];
        } else {
            this.filteredData = this.allData.filter(row => 
                row.candidateName.toLowerCase().includes(term) || 
                row.clientName.toLowerCase().includes(term) ||
                row.Name.toLowerCase().includes(term)
            );
        }
    }

    handleRowSelection(event) {
        const selectedRows = event.detail.selectedRows;
        this.selectedIds = selectedRows.map(row => row.Id);
    }

    get isGenerateDisabled() {
        return this.selectedIds.length === 0;
    }

    handleGenerate() {
        this.isLoading = true;
        massGenerateTimesheetPDFs({ timesheetIds: this.selectedIds })
            .then(message => {
                this.showToast('Job Queued Successfully', message, 'success');
                // We don't refresh the table, because background processing takes time!
            })
            .catch(error => {
                this.showToast('Generation Failed', error.body?.message || error.message, 'error');
            })
            .finally(() => {
                this.isLoading = false;
            });
    }

    showToast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant, mode: variant==='error'?'sticky':'dismissable' }));
    }
}