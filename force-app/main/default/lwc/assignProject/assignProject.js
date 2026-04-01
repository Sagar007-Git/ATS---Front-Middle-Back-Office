import { LightningElement, api, track } from 'lwc';
import getPopupConfiguration from '@salesforce/apex/DynamicCMDTController.getPopupConfiguration';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { CloseActionScreenEvent } from 'lightning/actions';
import { NotifyRecordUpdateAvailable } from 'lightning/uiRecordApi';

export default class AssignProject extends LightningElement {
    @api recordId; 
    @track config;
    @track dynamicFields = [];
    @track isLoading = true;
    @track errorMessage;

    connectedCallback() {
        this.fetchDynamicConfiguration();
    }

    fetchDynamicConfiguration() {
        getPopupConfiguration({ sourceRecordId: this.recordId, actionName: 'Assign_Project' })
            .then(result => {
                this.config = result;
                
                // Deduplicate and prepare fields for display
                const uniqueFields = [];
                const seenFields = new Set();
                let index = 0;

                result.fields.forEach(field => {
                    if (!seenFields.has(field.fieldApiName)) {
                        seenFields.add(field.fieldApiName);
                        uniqueFields.push({ ...field, uId: field.fieldApiName + '-' + index++ });
                    }
                });

                this.dynamicFields = uniqueFields;
                this.isLoading = false;
            })
            .catch(error => {
                this.errorMessage = error.body ? error.body.message : error.message;
                this.isLoading = false;
            });
    }

    handleError(event) {
        this.isLoading = false;
        const message = event.detail.detail || event.detail.message;
        this.dispatchEvent(new ShowToastEvent({
            title: 'Error Saving Record',
            message: message,
            variant: 'error',
            mode: 'sticky'
        }));
    }

    handleSuccess(event) {
        this.dispatchEvent(new ShowToastEvent({
            title: 'Success',
            message: 'Project assigned successfully.',
            variant: 'success',
        }));
        
        NotifyRecordUpdateAvailable([{ recordId: this.recordId }]);
        this.closeAction();
    }

    closeAction() {
        this.dispatchEvent(new CloseActionScreenEvent());
    }
}