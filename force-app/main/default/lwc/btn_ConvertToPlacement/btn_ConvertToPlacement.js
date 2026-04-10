import { LightningElement, api, track } from 'lwc';
import { CloseActionScreenEvent } from 'lightning/actions';
import { NavigationMixin } from 'lightning/navigation';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';

// ✅ Import the UI Refresh module
import { notifyRecordUpdateAvailable } from 'lightning/uiRecordApi'; 

import getExistingPlacementId from '@salesforce/apex/PrxmDynamicActionCtrl.getExistingPlacementId'; 
import linkPlacementToApplicant from '@salesforce/apex/PrxmDynamicActionCtrl.linkPlacementToApplicant'; 

export default class Btn_ConvertToPlacement extends NavigationMixin(LightningElement) {
    
    _recordId;
    @api 
    get recordId() { return this._recordId; }
    set recordId(value) {
        this._recordId = value;
        if (value) { this.checkForExistingPlacement(); }
    }
    
    @track step = 0; 
    @track isLoading = true; 
    @track newPlacementId;
    @track projectResourceOverrides = null;

    wizardSteps = [
        { label: 'Create Placement', value: '1' },
        { label: 'Create Project Resource', value: '2' }
    ];

    get isStepPlacement() { return this.step === 1; }
    get isStepProjectResource() { return this.step === 2; }

    checkForExistingPlacement() {
        this.isLoading = true;
        getExistingPlacementId({ jobApplicantId: this.recordId })
            .then(existingId => {
                if (existingId) {
                    this.newPlacementId = existingId;
                    this.projectResourceOverrides = { 'Placement__c': this.newPlacementId };
                    this.step = 2;
                    this.showToast('Placement Found', 'Resuming at Project Resource creation.', 'info');
                } else {
                    this.step = 1;
                }
            })
            .catch(error => {
                console.error('Error checking placement:', error);
                this.step = 1; 
            })
            .finally(() => {
                this.isLoading = false;
            });
    }

    handlePlacementSaved(event) {
        const createdRecordId = event.detail?.recordId;

        if (!createdRecordId) {
            this.showToast('Error', 'Failed to capture the new Placement ID.', 'error');
            return;
        }

        this.newPlacementId = createdRecordId;
        this.isLoading = true; 

        // Call Apex to stamp the Job Applicant record
        linkPlacementToApplicant({ jobApplicantId: this.recordId, placementId: this.newPlacementId })
            .then(() => {
                // ✅ Tell the Salesforce UI to instantly refresh the Job Applicant screen!
                notifyRecordUpdateAvailable([{ recordId: this.recordId }]);
                
                this.showToast('Placement Created', 'Now let\'s create the Project Resource (SOW).', 'success');
                this.projectResourceOverrides = { 'Placement__c': this.newPlacementId };
                this.step = 2; 
            })
            .catch(error => {
                console.error('Linking error:', error);
                this.showToast('Linking Failed', 'Placement was created, but failed to link to Applicant.', 'error');
            })
            .finally(() => {
                this.isLoading = false;
            });
    }

    handleProjectResourceSaved(event) {
        const newProjectResourceId = event.detail?.recordId;
        if (!newProjectResourceId) return;
        this.showToast('Project Resource Created', 'Conversion completed successfully!', 'success');
        this.navigateToRecord(newProjectResourceId);
        this.closeQuickAction();
    }

    showToast(title, message, variant, mode = 'dismissible') {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant, mode }));
    }

    navigateToRecord(recordIdToView) {
        this[NavigationMixin.Navigate]({
            type: 'standard__recordPage',
            attributes: { recordId: recordIdToView, actionName: 'view' }
        });
    }

    closeQuickAction() {
        this.dispatchEvent(new CloseActionScreenEvent());
    }
}