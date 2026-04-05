import { LightningElement, api, wire, track } from 'lwc';
import { CloseActionScreenEvent } from 'lightning/actions';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { NavigationMixin } from 'lightning/navigation';
import { notifyRecordUpdateAvailable } from 'lightning/uiRecordApi'; // Fixed capitalization

import getPopupConfiguration from '@salesforce/apex/DynamicCMDTController.getPopupConfiguration';

export default class CreateDealSheetAction extends NavigationMixin(LightningElement) {
    @api recordId; 
    
    // --- CONFIGURATION ---
    targetObjectApiName = 'Deal_Sheet__c'; 
    actionName = 'Create_Deal_Sheet'; 
    parentFieldApiName = 'Placement__c'; 
    // -----------------------------------------------------

    @track dynamicFields = [];
    @track isLoading = true;

    // 1. FETCH UI RULES AND DATA FROM CMDT
    @wire(getPopupConfiguration, { sourceRecordId: '$recordId', actionName: '$actionName' })
    wiredConfig({ error, data }) {
        if (data && data.fields) {
            
            let seenFields = new Set();
            let uniqueFields = [];
            let index = 0;

            // 🛡️ THE DUPLICATE KILLER
            data.fields.forEach(field => {
                if (!seenFields.has(field.fieldApiName)) {
                    seenFields.add(field.fieldApiName);
                    uniqueFields.push({ 
                        ...field, 
                        uId: field.fieldApiName + '-' + index++ 
                    });
                }
            });
            
            this.dynamicFields = uniqueFields;
            this.isLoading = false;
            
        } else if (error) {
            let errorMessage = error.body ? error.body.message : 'An unknown error occurred.';
            this.dispatchEvent(new ShowToastEvent({ title: 'Configuration Error', message: errorMessage, variant: 'error', mode: 'sticky' }));
            this.isLoading = false;
        }
    }

    // 2. INTERCEPT SAVE AND HARD-LINK TO PLACEMENT
    handleSubmit(event) {
        event.preventDefault(); 
        this.isLoading = true;  
        const fields = event.detail.fields;
        
        fields[this.parentFieldApiName] = this.recordId; 
        
        this.template.querySelector('lightning-record-edit-form').submit(fields);
    }

    // 3. SHOW SUCCESS AND NAVIGATE (FIXED RACE CONDITION)
    handleSuccess(event) {
        this.isLoading = false;
        
        // 1. Show the success message immediately
        this.dispatchEvent(new ShowToastEvent({ 
            title: 'Success', 
            message: 'Deal Sheet Created!', 
            variant: 'success' 
        }));
        
        // 2. Notify the framework to refresh the background data
        notifyRecordUpdateAvailable([{ recordId: this.recordId }]);
        
        // 3. THE FIX: Delay the close and navigation by 100ms 
        // This gives lightning-record-edit-form time to finish its internal promises
        setTimeout(() => {
            this.dispatchEvent(new CloseActionScreenEvent());
            
            this[NavigationMixin.Navigate]({
                type: 'standard__recordPage',
                attributes: { 
                    recordId: event.detail.id, 
                    objectApiName: this.targetObjectApiName, 
                    actionName: 'view' 
                }
            });
        }, 100);
    }

    // 4. CATCH ERRORS SO IT DOESN'T SPIN FOREVER
    handleError(event) {
        this.isLoading = false; 
        
        const message = event.detail.detail || event.detail.message || 'Check your required fields or validation rules.';
        
        this.dispatchEvent(new ShowToastEvent({
            title: 'Error Saving Deal Sheet',
            message: message,
            variant: 'error',
            mode: 'sticky' 
        }));
    }

    closeAction() {
        this.dispatchEvent(new CloseActionScreenEvent());
    }
}