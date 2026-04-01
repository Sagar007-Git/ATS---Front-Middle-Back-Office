import { LightningElement, api, track } from 'lwc';
import { CloseActionScreenEvent } from 'lightning/actions';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { NavigationMixin } from 'lightning/navigation';
import { NotifyRecordUpdateAvailable, updateRecord } from 'lightning/uiRecordApi';

import getPopupConfiguration from '@salesforce/apex/DynamicCMDTController.getPopupConfiguration';
import getExistingPlacementId from '@salesforce/apex/JobApplicantHelper.getExistingPlacementId';

export default class ConvertToPlacement extends NavigationMixin(LightningElement) {
    
    // --- INITIALIZATION LOCK ---
    _recordId;
    _isInitialized = false;

    @api set recordId(value) {
        this._recordId = value;
        if (value && !this._isInitialized) {
            this._isInitialized = true;
            this.initializeComponent();
        }
    }
    get recordId() {
        return this._recordId;
    }

    @track targetObjectApiName; 
    @track dynamicFields; 
    @track isLoading = true;
    @track isAlreadyPlaced = false;
    existingPlacementId = null; 

    // --- MAIN BOOTUP SEQUENCE ---
    async initializeComponent() {
        try {
            // 1. LIVE Duplicate Check
            const duplicateId = await getExistingPlacementId({ applicantId: this._recordId });

            if (duplicateId) {
                this.existingPlacementId = duplicateId;
                this.isAlreadyPlaced = true;
                this.isLoading = false;
                return;
            }

            // 2. Fetch Metadata
            const configData = await getPopupConfiguration({ 
                sourceRecordId: this._recordId, 
                actionName: 'Convert_To_Placement' 
            });

            if (configData) {
                this.targetObjectApiName = configData.targetObjectName;
                
                // 3. THE DEDUPLICATOR (Stops UI Crashes)
                const uniqueFields = [];
                const seenFields = new Set();
                let index = 0;

                configData.fields.forEach(field => {
                    if (!seenFields.has(field.fieldApiName)) {
                        seenFields.add(field.fieldApiName);
                        uniqueFields.push({ 
                            ...field, 
                            uId: field.fieldApiName + '-' + index++ 
                        });
                    }
                });

                this.dynamicFields = uniqueFields;
            }

            this.isLoading = false;

        } catch (error) {
            console.error('Initialization Error:', error);
            this.showToast('Initialization Error', error.body?.message || error.message, 'error', 'sticky');
            this.isLoading = false;
        }
    }

    // --- FORM ACTIONS ---
    handleSubmit(event) {
        event.preventDefault(); 
        this.isLoading = true;  
        
        const fields = event.detail.fields;
        fields.Job_Applicant__c = this._recordId; // Hard-link to current record
        
        this.template.querySelector('lightning-record-edit-form').submit(fields);
    }

    handleError(event) {
        this.isLoading = false; 
        const message = event.detail.detail || event.detail.message;
        this.showToast('Validation Error', message, 'error', 'sticky');
    }

    handleSuccess(event) {
        const newPlacementId = event.detail.id;

        // INSTANT BIDIRECTIONAL SYNC: Update the Job Applicant with the new Placement ID
        const recordInput = {
            fields: {
                Id: this._recordId,
                Placement__c: newPlacementId 
            }
        };

        updateRecord(recordInput)
            .then(() => {
                this.isLoading = false;
                this.showToast('Success', 'Placement Created & Applicant Updated!', 'success', 'dismissible');
                
                NotifyRecordUpdateAvailable([{ recordId: this._recordId }]);
                
                this.dispatchEvent(new CloseActionScreenEvent());
                this.navigateToRecord(newPlacementId);
            })
            .catch(error => {
                this.isLoading = false;
                // Even if sync fails, the placement was created, so we still navigate them
                this.showToast('Sync Warning', 'Placement created, but failed to link back to Applicant.', 'warning', 'sticky');
                this.dispatchEvent(new CloseActionScreenEvent());
                this.navigateToRecord(newPlacementId);
            });
    }

    // --- UTILITIES ---
    viewExistingPlacement() {
        this.navigateToRecord(this.existingPlacementId);
    }

    navigateToRecord(recId) {
        this[NavigationMixin.Navigate]({
            type: 'standard__recordPage',
            attributes: { 
                recordId: recId, 
                objectApiName: 'Placement__c', 
                actionName: 'view' 
            }
        });
    }

    closeAction() {
        this.dispatchEvent(new CloseActionScreenEvent());
    }

    showToast(title, message, variant, mode) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant, mode }));
    }
}