/**
 * DTO Wrapper class to strongly type the JSON sent to the LWC.
 * Uses Prxm prefix to support managed packaging.
 */
public with sharing class PrxmActionConfig {
    
    @AuraEnabled public String targetObjectApiName { get; set; }
    @AuraEnabled public String title { get; set; }
    @AuraEnabled public List<FieldConfig> fields { get; set; }

    public PrxmActionConfig() {
        this.fields = new List<FieldConfig>();
    }

    public class FieldConfig {
        @AuraEnabled public String id { get; set; } // Unique key for LWC iteration
        @AuraEnabled public String apiName { get; set; }
        @AuraEnabled public Object defaultValue { get; set; } // Object to handle Boolean, Decimal, String
        @AuraEnabled public Boolean isRequired { get; set; }
        @AuraEnabled public Boolean isReadOnly { get; set; }
        @AuraEnabled public Boolean isHidden { get; set; }
        @AuraEnabled public String sectionName { get; set; }
        @AuraEnabled public Decimal order { get; set; }
    }
}