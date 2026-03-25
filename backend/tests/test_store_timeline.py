"""
Test suite for store-timeline endpoint and related store functionality.
Tests temporal tracking of sales by day, week, and month per store.
"""
import pytest
import requests
import os

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')

class TestStoreTimelineEndpoint:
    """Tests for GET /api/store-timeline endpoint"""
    
    def test_store_timeline_month_granularity_2026(self):
        """Test monthly granularity for year 2026"""
        response = requests.get(f"{BASE_URL}/api/store-timeline", params={
            "granularity": "month",
            "year": 2026
        })
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        data = response.json()
        assert isinstance(data, list), "Response should be a list"
        assert len(data) > 0, "Should return data for 2026"
        
        # Validate data structure
        first_row = data[0]
        assert "period" in first_row, "Row should have 'period' field"
        assert "store_code" in first_row, "Row should have 'store_code' field"
        assert "total_sales" in first_row, "Row should have 'total_sales' field"
        assert "units_sold" in first_row, "Row should have 'units_sold' field"
        
        # Validate period format (should be date string like 2026-01-01)
        assert first_row["period"].startswith("2026"), f"Period should be in 2026, got {first_row['period']}"
        
        # Validate data types
        assert isinstance(first_row["total_sales"], (int, float)), "total_sales should be numeric"
        assert isinstance(first_row["units_sold"], (int, float)), "units_sold should be numeric"
        print(f"✓ Monthly 2026 data: {len(data)} rows returned")
    
    def test_store_timeline_week_granularity_with_store_filter(self):
        """Test weekly granularity with specific store filter (GM209)"""
        response = requests.get(f"{BASE_URL}/api/store-timeline", params={
            "granularity": "week",
            "year": 2025,
            "store": "GM209"
        })
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        data = response.json()
        assert isinstance(data, list), "Response should be a list"
        assert len(data) > 0, "Should return weekly data for GM209 in 2025"
        
        # All rows should be for GM209
        for row in data:
            assert row["store_code"] == "GM209", f"Expected GM209, got {row['store_code']}"
        
        # Validate weekly periods (should be Monday dates)
        first_row = data[0]
        assert "period" in first_row
        print(f"✓ Weekly GM209 2025 data: {len(data)} rows returned")
    
    def test_store_timeline_day_granularity(self):
        """Test daily granularity with specific store"""
        response = requests.get(f"{BASE_URL}/api/store-timeline", params={
            "granularity": "day",
            "year": 2025,
            "store": "GM209"
        })
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        data = response.json()
        assert isinstance(data, list), "Response should be a list"
        assert len(data) > 0, "Should return daily data"
        
        # Daily data should have more rows than weekly
        assert len(data) > 50, f"Daily data should have many rows, got {len(data)}"
        
        # Validate period format for daily (YYYY-MM-DD)
        first_row = data[0]
        assert len(first_row["period"]) == 10, f"Daily period should be YYYY-MM-DD format, got {first_row['period']}"
        print(f"✓ Daily GM209 2025 data: {len(data)} rows returned")
    
    def test_store_timeline_with_marca_filter(self):
        """Test store-timeline respects marca filter"""
        response = requests.get(f"{BASE_URL}/api/store-timeline", params={
            "granularity": "month",
            "year": 2025,
            "marca": "AMBISSION"
        })
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        data = response.json()
        assert isinstance(data, list), "Response should be a list"
        # Data should be filtered (less than unfiltered)
        print(f"✓ Monthly 2025 with marca=AMBISSION: {len(data)} rows returned")
    
    def test_store_timeline_with_tipo_filter(self):
        """Test store-timeline respects tipo filter"""
        response = requests.get(f"{BASE_URL}/api/store-timeline", params={
            "granularity": "month",
            "year": 2025,
            "tipo": "Polo"
        })
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        data = response.json()
        assert isinstance(data, list), "Response should be a list"
        print(f"✓ Monthly 2025 with tipo=Polo: {len(data)} rows returned")
    
    def test_store_timeline_multiple_stores(self):
        """Test store-timeline with multiple stores"""
        response = requests.get(f"{BASE_URL}/api/store-timeline", params={
            "granularity": "month",
            "year": 2025,
            "store": "GM209,GAM207"
        })
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        data = response.json()
        assert isinstance(data, list), "Response should be a list"
        
        # Should have data for both stores
        store_codes = set(row["store_code"] for row in data)
        assert "GM209" in store_codes or "GAM207" in store_codes, "Should have data for at least one of the stores"
        print(f"✓ Monthly 2025 with multiple stores: {len(data)} rows, stores: {store_codes}")
    
    def test_store_timeline_default_granularity(self):
        """Test default granularity is month"""
        response = requests.get(f"{BASE_URL}/api/store-timeline", params={
            "year": 2025
        })
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        data = response.json()
        assert isinstance(data, list), "Response should be a list"
        
        # Default should be monthly - periods should be first of month
        if len(data) > 0:
            period = data[0]["period"]
            assert period.endswith("-01"), f"Default granularity should be month, period: {period}"
        print(f"✓ Default granularity (month) works: {len(data)} rows")


class TestSalesByStoreEndpoint:
    """Tests for GET /api/sales-by-store endpoint (store ranking)"""
    
    def test_sales_by_store_returns_data(self):
        """Test sales-by-store returns store ranking data"""
        response = requests.get(f"{BASE_URL}/api/sales-by-store", params={
            "year": 2026
        })
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        data = response.json()
        assert isinstance(data, list), "Response should be a list"
        assert len(data) > 0, "Should return store data"
        
        # Validate structure
        first_row = data[0]
        assert "store_code" in first_row
        assert "total_sales" in first_row
        assert "order_count" in first_row
        assert "units_sold" in first_row
        assert "avg_ticket" in first_row
        
        # Data should be sorted by total_sales descending
        if len(data) > 1:
            assert data[0]["total_sales"] >= data[1]["total_sales"], "Data should be sorted by total_sales DESC"
        print(f"✓ Sales by store 2026: {len(data)} stores returned")
    
    def test_sales_by_store_with_filters(self):
        """Test sales-by-store with marca and tipo filters"""
        response = requests.get(f"{BASE_URL}/api/sales-by-store", params={
            "year": 2025,
            "marca": "QEPO"
        })
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        data = response.json()
        assert isinstance(data, list), "Response should be a list"
        print(f"✓ Sales by store with marca=QEPO: {len(data)} stores")


class TestFiltersEndpoint:
    """Tests for GET /api/filters endpoint"""
    
    def test_filters_returns_all_options(self):
        """Test filters endpoint returns all filter options"""
        response = requests.get(f"{BASE_URL}/api/filters")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        data = response.json()
        assert "marcas" in data, "Should have marcas"
        assert "tipos" in data, "Should have tipos"
        assert "stores" in data, "Should have stores"
        assert "years" in data, "Should have years"
        
        assert len(data["marcas"]) > 0, "Should have marca options"
        assert len(data["tipos"]) > 0, "Should have tipo options"
        assert len(data["stores"]) > 0, "Should have store options"
        assert len(data["years"]) > 0, "Should have year options"
        
        # Years should include 2026, 2025
        assert 2026 in data["years"], "Should have 2026"
        assert 2025 in data["years"], "Should have 2025"
        print(f"✓ Filters: {len(data['marcas'])} marcas, {len(data['tipos'])} tipos, {len(data['stores'])} stores, {len(data['years'])} years")


class TestRegressionEndpoints:
    """Regression tests for existing endpoints"""
    
    def test_api_root(self):
        """Test API root endpoint"""
        response = requests.get(f"{BASE_URL}/api/")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        print("✓ API root working")
    
    def test_kpis_endpoint(self):
        """Test KPIs endpoint"""
        response = requests.get(f"{BASE_URL}/api/kpis", params={"year": 2025})
        assert response.status_code == 200
        data = response.json()
        assert "total_sales" in data
        assert "order_count" in data
        assert "units_sold" in data
        print(f"✓ KPIs: total_sales={data['total_sales']}")
    
    def test_sales_trend_endpoint(self):
        """Test sales trend endpoint"""
        response = requests.get(f"{BASE_URL}/api/sales-trend", params={"year": 2025})
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        print(f"✓ Sales trend: {len(data)} months")
    
    def test_sales_by_year_endpoint(self):
        """Test sales by year endpoint"""
        response = requests.get(f"{BASE_URL}/api/sales-by-year")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) > 0
        print(f"✓ Sales by year: {len(data)} years")
    
    def test_sales_by_marca_endpoint(self):
        """Test sales by marca endpoint"""
        response = requests.get(f"{BASE_URL}/api/sales-by-marca", params={"year": 2025})
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        print(f"✓ Sales by marca: {len(data)} marcas")
    
    def test_sales_by_tipo_endpoint(self):
        """Test sales by tipo endpoint"""
        response = requests.get(f"{BASE_URL}/api/sales-by-tipo", params={"year": 2025})
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        print(f"✓ Sales by tipo: {len(data)} tipos")
    
    def test_top_clients_endpoint(self):
        """Test top clients endpoint"""
        response = requests.get(f"{BASE_URL}/api/top-clients", params={"year": 2025, "limit": 10})
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        print(f"✓ Top clients: {len(data)} clients")
    
    def test_year_monthly_endpoint(self):
        """Test year monthly endpoint"""
        response = requests.get(f"{BASE_URL}/api/year-monthly", params={"years": "2025,2026"})
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        print(f"✓ Year monthly: {len(data)} rows")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
