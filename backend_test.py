#!/usr/bin/env python3
"""
CRM Sales Reports Backend API Testing
Tests all endpoints against external PostgreSQL database
"""

import requests
import sys
import time
from datetime import datetime
from typing import Dict, Any, List

class CRMAPITester:
    def __init__(self, base_url="https://pos-revenue-tracker.preview.emergentagent.com"):
        self.base_url = base_url
        self.tests_run = 0
        self.tests_passed = 0
        self.failed_tests = []
        self.test_results = {}

    def log_test(self, name: str, success: bool, details: str = "", response_data: Any = None):
        """Log test result"""
        self.tests_run += 1
        if success:
            self.tests_passed += 1
            print(f"✅ {name}: PASSED")
        else:
            self.failed_tests.append({"name": name, "details": details})
            print(f"❌ {name}: FAILED - {details}")
        
        self.test_results[name] = {
            "success": success,
            "details": details,
            "response_data": response_data
        }

    def make_request(self, method: str, endpoint: str, params: Dict = None, timeout: int = 10) -> tuple:
        """Make HTTP request with error handling"""
        url = f"{self.base_url}/api/{endpoint}"
        headers = {'Content-Type': 'application/json'}
        
        try:
            start_time = time.time()
            if method == 'GET':
                response = requests.get(url, params=params, headers=headers, timeout=timeout)
            elif method == 'POST':
                response = requests.post(url, json=params, headers=headers, timeout=timeout)
            else:
                return False, f"Unsupported method: {method}", None, 0
            
            duration = time.time() - start_time
            
            if response.status_code == 200:
                try:
                    data = response.json()
                    return True, f"Status: {response.status_code}, Duration: {duration:.2f}s", data, duration
                except:
                    return False, f"Status: {response.status_code}, Invalid JSON response", None, duration
            else:
                return False, f"Status: {response.status_code}, Response: {response.text[:200]}", None, duration
                
        except requests.exceptions.Timeout:
            return False, f"Request timeout after {timeout}s", None, timeout
        except requests.exceptions.ConnectionError:
            return False, "Connection error - server may be down", None, 0
        except Exception as e:
            return False, f"Request error: {str(e)}", None, 0

    def test_root_endpoint(self):
        """Test root API endpoint"""
        success, details, data, duration = self.make_request('GET', '')
        expected_message = "CRM Reports API"
        
        if success and data and data.get('message') == expected_message:
            self.log_test("Root Endpoint", True, details, data)
        else:
            self.log_test("Root Endpoint", False, f"{details} - Expected message: {expected_message}")

    def test_filters_endpoint(self):
        """Test filters endpoint - should return marcas, tipos, stores, years"""
        success, details, data, duration = self.make_request('GET', 'filters', timeout=15)
        
        if not success:
            self.log_test("Filters Endpoint", False, details)
            return None
        
        # Validate response structure
        required_keys = ['marcas', 'tipos', 'stores', 'years']
        missing_keys = [key for key in required_keys if key not in data]
        
        if missing_keys:
            self.log_test("Filters Endpoint", False, f"Missing keys: {missing_keys}")
            return None
        
        # Validate data types and content
        if not isinstance(data['marcas'], list) or len(data['marcas']) == 0:
            self.log_test("Filters Endpoint", False, "marcas should be non-empty list")
            return None
        
        if not isinstance(data['tipos'], list) or len(data['tipos']) == 0:
            self.log_test("Filters Endpoint", False, "tipos should be non-empty list")
            return None
        
        if not isinstance(data['stores'], list) or len(data['stores']) == 0:
            self.log_test("Filters Endpoint", False, "stores should be non-empty list")
            return None
        
        if not isinstance(data['years'], list) or len(data['years']) == 0:
            self.log_test("Filters Endpoint", False, "years should be non-empty list")
            return None
        
        self.log_test("Filters Endpoint", True, f"{details} - Found {len(data['marcas'])} marcas, {len(data['tipos'])} tipos, {len(data['stores'])} stores, {len(data['years'])} years")
        return data

    def test_kpis_endpoint(self, filters_data: Dict = None):
        """Test KPIs endpoint with various parameters"""
        # Test basic KPIs for current year
        current_year = datetime.now().year
        params = {
            'start_date': f'{current_year}-01-01',
            'end_date': f'{current_year + 1}-01-01'
        }
        
        success, details, data, duration = self.make_request('GET', 'kpis', params, timeout=15)
        
        if not success:
            self.log_test("KPIs Endpoint (Basic)", False, details)
            return
        
        # Validate KPI structure
        required_fields = ['total_sales', 'order_count', 'units_sold', 'avg_ticket']
        missing_fields = [field for field in required_fields if field not in data]
        
        if missing_fields:
            self.log_test("KPIs Endpoint (Basic)", False, f"Missing fields: {missing_fields}")
            return
        
        # Validate data types
        for field in required_fields:
            if not isinstance(data[field], (int, float)):
                self.log_test("KPIs Endpoint (Basic)", False, f"{field} should be numeric, got {type(data[field])}")
                return
        
        self.log_test("KPIs Endpoint (Basic)", True, f"{details} - Sales: {data['total_sales']}, Orders: {data['order_count']}")
        
        # Test with filters if available
        if filters_data:
            # Test with marca filter
            if filters_data['marcas']:
                params_with_marca = {**params, 'marca': filters_data['marcas'][0]}
                success, details, data, duration = self.make_request('GET', 'kpis', params_with_marca, timeout=15)
                self.log_test("KPIs Endpoint (With Marca Filter)", success, details)
            
            # Test with store filter
            if filters_data['stores']:
                params_with_store = {**params, 'store': filters_data['stores'][0]}
                success, details, data, duration = self.make_request('GET', 'kpis', params_with_store, timeout=15)
                self.log_test("KPIs Endpoint (With Store Filter)", success, details)

    def test_sales_trend_endpoint(self):
        """Test sales trend endpoint"""
        current_year = datetime.now().year
        params = {'year': current_year}
        
        success, details, data, duration = self.make_request('GET', 'sales-trend', params, timeout=15)
        
        if not success:
            self.log_test("Sales Trend Endpoint", False, details)
            return
        
        if not isinstance(data, list):
            self.log_test("Sales Trend Endpoint", False, "Response should be a list")
            return
        
        # Validate structure of trend data
        if data:
            required_fields = ['month', 'total_sales', 'order_count', 'units_sold']
            sample = data[0]
            missing_fields = [field for field in required_fields if field not in sample]
            
            if missing_fields:
                self.log_test("Sales Trend Endpoint", False, f"Missing fields in trend data: {missing_fields}")
                return
        
        self.log_test("Sales Trend Endpoint", True, f"{details} - Found {len(data)} months of data")

    def test_sales_by_year_endpoint(self):
        """Test sales by year endpoint"""
        success, details, data, duration = self.make_request('GET', 'sales-by-year', timeout=15)
        
        if not success:
            self.log_test("Sales By Year Endpoint", False, details)
            return
        
        if not isinstance(data, list):
            self.log_test("Sales By Year Endpoint", False, "Response should be a list")
            return
        
        if data:
            required_fields = ['year', 'total_sales', 'order_count', 'units_sold', 'avg_ticket']
            sample = data[0]
            missing_fields = [field for field in required_fields if field not in sample]
            
            if missing_fields:
                self.log_test("Sales By Year Endpoint", False, f"Missing fields: {missing_fields}")
                return
        
        self.log_test("Sales By Year Endpoint", True, f"{details} - Found {len(data)} years of data")

    def test_year_monthly_endpoint(self):
        """Test year monthly comparison endpoint"""
        current_year = datetime.now().year
        years = f"{current_year-1},{current_year}"
        params = {'years': years}
        
        success, details, data, duration = self.make_request('GET', 'year-monthly', params, timeout=15)
        
        if not success:
            self.log_test("Year Monthly Endpoint", False, details)
            return
        
        if not isinstance(data, list):
            self.log_test("Year Monthly Endpoint", False, "Response should be a list")
            return
        
        if data:
            required_fields = ['year', 'month', 'total_sales', 'order_count', 'units_sold']
            sample = data[0]
            missing_fields = [field for field in required_fields if field not in sample]
            
            if missing_fields:
                self.log_test("Year Monthly Endpoint", False, f"Missing fields: {missing_fields}")
                return
        
        self.log_test("Year Monthly Endpoint", True, f"{details} - Found {len(data)} month records")

    def test_sales_by_marca_endpoint(self):
        """Test sales by marca endpoint"""
        current_year = datetime.now().year
        params = {'year': current_year}
        
        success, details, data, duration = self.make_request('GET', 'sales-by-marca', params, timeout=15)
        
        if not success:
            self.log_test("Sales By Marca Endpoint", False, details)
            return
        
        if not isinstance(data, list):
            self.log_test("Sales By Marca Endpoint", False, "Response should be a list")
            return
        
        if data:
            required_fields = ['marca', 'total_sales', 'order_count', 'units_sold', 'avg_ticket']
            sample = data[0]
            missing_fields = [field for field in required_fields if field not in sample]
            
            if missing_fields:
                self.log_test("Sales By Marca Endpoint", False, f"Missing fields: {missing_fields}")
                return
        
        self.log_test("Sales By Marca Endpoint", True, f"{details} - Found {len(data)} marcas")

    def test_sales_by_tipo_endpoint(self):
        """Test sales by tipo endpoint"""
        current_year = datetime.now().year
        params = {'year': current_year}
        
        success, details, data, duration = self.make_request('GET', 'sales-by-tipo', params, timeout=15)
        
        if not success:
            self.log_test("Sales By Tipo Endpoint", False, details)
            return
        
        if not isinstance(data, list):
            self.log_test("Sales By Tipo Endpoint", False, "Response should be a list")
            return
        
        if data:
            required_fields = ['tipo', 'total_sales', 'order_count', 'units_sold', 'avg_ticket']
            sample = data[0]
            missing_fields = [field for field in required_fields if field not in sample]
            
            if missing_fields:
                self.log_test("Sales By Tipo Endpoint", False, f"Missing fields: {missing_fields}")
                return
        
        self.log_test("Sales By Tipo Endpoint", True, f"{details} - Found {len(data)} tipos")

    def test_sales_by_store_endpoint(self):
        """Test sales by store endpoint"""
        current_year = datetime.now().year
        params = {'year': current_year}
        
        success, details, data, duration = self.make_request('GET', 'sales-by-store', params, timeout=15)
        
        if not success:
            self.log_test("Sales By Store Endpoint", False, details)
            return
        
        if not isinstance(data, list):
            self.log_test("Sales By Store Endpoint", False, "Response should be a list")
            return
        
        if data:
            required_fields = ['store_code', 'total_sales', 'order_count', 'units_sold', 'avg_ticket']
            sample = data[0]
            missing_fields = [field for field in required_fields if field not in sample]
            
            if missing_fields:
                self.log_test("Sales By Store Endpoint", False, f"Missing fields: {missing_fields}")
                return
        
        self.log_test("Sales By Store Endpoint", True, f"{details} - Found {len(data)} stores")

    def test_top_clients_endpoint(self):
        """Test top clients endpoint"""
        current_year = datetime.now().year
        params = {'year': current_year, 'limit': 10}
        
        success, details, data, duration = self.make_request('GET', 'top-clients', params, timeout=15)
        
        if not success:
            self.log_test("Top Clients Endpoint", False, details)
            return data
        
        if not isinstance(data, list):
            self.log_test("Top Clients Endpoint", False, "Response should be a list")
            return None
        
        if data:
            required_fields = ['client_id', 'client_name', 'order_count', 'total_sales', 'units_sold', 'avg_ticket']
            sample = data[0]
            missing_fields = [field for field in required_fields if field not in sample]
            
            if missing_fields:
                self.log_test("Top Clients Endpoint", False, f"Missing fields: {missing_fields}")
                return None
        
        self.log_test("Top Clients Endpoint", True, f"{details} - Found {len(data)} clients")
        return data

    def test_client_years_endpoint(self, clients_data: List = None):
        """Test client years endpoint"""
        if not clients_data or len(clients_data) == 0:
            self.log_test("Client Years Endpoint", False, "No client data available for testing")
            return
        
        # Test with first client
        client_id = clients_data[0]['client_id']
        params = {'client_id': client_id}
        
        success, details, data, duration = self.make_request('GET', 'client-years', params, timeout=15)
        
        if not success:
            self.log_test("Client Years Endpoint", False, details)
            return
        
        if not isinstance(data, list):
            self.log_test("Client Years Endpoint", False, "Response should be a list")
            return
        
        if data:
            required_fields = ['year', 'total_sales', 'order_count', 'units_sold']
            sample = data[0]
            missing_fields = [field for field in required_fields if field not in sample]
            
            if missing_fields:
                self.log_test("Client Years Endpoint", False, f"Missing fields: {missing_fields}")
                return
        
        self.log_test("Client Years Endpoint", True, f"{details} - Found {len(data)} years for client {client_id}")

    def test_export_excel_endpoint(self):
        """Test Excel export endpoint"""
        params = {'report': 'sales-by-year'}
        
        # For Excel export, we expect a different response (file download)
        url = f"{self.base_url}/api/export/excel"
        
        try:
            response = requests.get(url, params=params, timeout=15)
            
            if response.status_code == 200:
                # Check if response is Excel file
                content_type = response.headers.get('content-type', '')
                if 'spreadsheet' in content_type or 'excel' in content_type:
                    self.log_test("Excel Export Endpoint", True, f"Status: 200, Content-Type: {content_type}")
                else:
                    self.log_test("Excel Export Endpoint", False, f"Unexpected content type: {content_type}")
            else:
                self.log_test("Excel Export Endpoint", False, f"Status: {response.status_code}")
                
        except Exception as e:
            self.log_test("Excel Export Endpoint", False, f"Request error: {str(e)}")

    def run_all_tests(self):
        """Run all API tests"""
        print("🚀 Starting CRM Sales Reports API Testing...")
        print(f"📍 Testing against: {self.base_url}")
        print("=" * 60)
        
        # Test basic connectivity
        self.test_root_endpoint()
        
        # Test filters (needed for other tests)
        filters_data = self.test_filters_endpoint()
        
        # Test KPIs
        self.test_kpis_endpoint(filters_data)
        
        # Test sales endpoints
        self.test_sales_trend_endpoint()
        self.test_sales_by_year_endpoint()
        self.test_year_monthly_endpoint()
        self.test_sales_by_marca_endpoint()
        self.test_sales_by_tipo_endpoint()
        self.test_sales_by_store_endpoint()
        
        # Test client endpoints
        clients_data = self.test_top_clients_endpoint()
        self.test_client_years_endpoint(clients_data)
        
        # Test export
        self.test_export_excel_endpoint()
        
        # Print summary
        print("\n" + "=" * 60)
        print(f"📊 Test Summary: {self.tests_passed}/{self.tests_run} tests passed")
        
        if self.failed_tests:
            print("\n❌ Failed Tests:")
            for test in self.failed_tests:
                print(f"  • {test['name']}: {test['details']}")
        
        return self.tests_passed == self.tests_run

def main():
    """Main test execution"""
    tester = CRMAPITester()
    success = tester.run_all_tests()
    
    # Save detailed results for analysis
    import json
    with open('/app/backend_test_results.json', 'w') as f:
        json.dump({
            'summary': {
                'total_tests': tester.tests_run,
                'passed_tests': tester.tests_passed,
                'failed_tests': len(tester.failed_tests),
                'success_rate': (tester.tests_passed / tester.tests_run * 100) if tester.tests_run > 0 else 0
            },
            'failed_tests': tester.failed_tests,
            'detailed_results': tester.test_results
        }, f, indent=2)
    
    return 0 if success else 1

if __name__ == "__main__":
    sys.exit(main())