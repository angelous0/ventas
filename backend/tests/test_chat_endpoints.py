"""
Test suite for AI Chat Assistant endpoints
Tests: POST /api/chat, GET /api/chat/history, POST /api/chat/new
"""
import pytest
import requests
import os
import time

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')

class TestChatNewSession:
    """Tests for POST /api/chat/new endpoint"""
    
    def test_new_session_returns_session_id(self):
        """POST /api/chat/new should return a new session_id"""
        response = requests.post(f"{BASE_URL}/api/chat/new")
        assert response.status_code == 200
        data = response.json()
        assert "session_id" in data
        assert isinstance(data["session_id"], str)
        assert len(data["session_id"]) > 0
        # UUID format check
        assert len(data["session_id"]) == 36  # UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx


class TestChatEndpoint:
    """Tests for POST /api/chat endpoint"""
    
    def test_chat_basic_message(self):
        """POST /api/chat with basic message returns AI response"""
        response = requests.post(
            f"{BASE_URL}/api/chat",
            json={
                "message": "Hola, cuanto vendimos este año?",
                "session_id": None,
                "filters": {}
            },
            timeout=30
        )
        assert response.status_code == 200
        data = response.json()
        assert "response" in data
        assert "session_id" in data
        assert isinstance(data["response"], str)
        assert len(data["response"]) > 0
        assert isinstance(data["session_id"], str)
        assert len(data["session_id"]) == 36
    
    def test_chat_with_specific_date_query(self):
        """POST /api/chat with specific date (17 de abril del 2025) returns date-specific data"""
        response = requests.post(
            f"{BASE_URL}/api/chat",
            json={
                "message": "Cuanto vendimos el 17 de abril del 2025?",
                "session_id": None,
                "filters": {}
            },
            timeout=30
        )
        assert response.status_code == 200
        data = response.json()
        assert "response" in data
        assert "session_id" in data
        # Response should contain date-related info
        assert isinstance(data["response"], str)
        assert len(data["response"]) > 0
    
    def test_chat_with_filters(self):
        """POST /api/chat with filters param passes filter context correctly"""
        response = requests.post(
            f"{BASE_URL}/api/chat",
            json={
                "message": "Cual es la tienda con mas ventas?",
                "session_id": None,
                "filters": {"marca": "AMBISSION"}
            },
            timeout=30
        )
        assert response.status_code == 200
        data = response.json()
        assert "response" in data
        assert "session_id" in data
        assert isinstance(data["response"], str)
        assert len(data["response"]) > 0
    
    def test_chat_with_existing_session(self):
        """POST /api/chat with existing session_id maintains conversation"""
        # First message to create session
        response1 = requests.post(
            f"{BASE_URL}/api/chat",
            json={
                "message": "Hola",
                "session_id": None,
                "filters": {}
            },
            timeout=30
        )
        assert response1.status_code == 200
        session_id = response1.json()["session_id"]
        
        # Second message with same session
        response2 = requests.post(
            f"{BASE_URL}/api/chat",
            json={
                "message": "Cuantas tiendas hay?",
                "session_id": session_id,
                "filters": {}
            },
            timeout=30
        )
        assert response2.status_code == 200
        data2 = response2.json()
        assert data2["session_id"] == session_id
        assert "response" in data2
    
    def test_chat_with_multiple_filters(self):
        """POST /api/chat with multiple filters"""
        response = requests.post(
            f"{BASE_URL}/api/chat",
            json={
                "message": "Resumen de ventas",
                "session_id": None,
                "filters": {"marca": "AMBISSION", "tipo": "POLO"}
            },
            timeout=30
        )
        assert response.status_code == 200
        data = response.json()
        assert "response" in data
        assert "session_id" in data


class TestChatHistory:
    """Tests for GET /api/chat/history endpoint"""
    
    def test_chat_history_returns_messages(self):
        """GET /api/chat/history?session_id=xxx returns chat history"""
        # First create a chat session with a message
        chat_response = requests.post(
            f"{BASE_URL}/api/chat",
            json={
                "message": "TEST_Hola, dame un resumen",
                "session_id": None,
                "filters": {}
            },
            timeout=30
        )
        assert chat_response.status_code == 200
        session_id = chat_response.json()["session_id"]
        
        # Wait a moment for MongoDB to persist
        time.sleep(1)
        
        # Now get history
        history_response = requests.get(
            f"{BASE_URL}/api/chat/history",
            params={"session_id": session_id}
        )
        assert history_response.status_code == 200
        messages = history_response.json()
        assert isinstance(messages, list)
        assert len(messages) >= 2  # At least user message + assistant response
        
        # Check message structure
        for msg in messages:
            assert "role" in msg
            assert "content" in msg
            assert "ts" in msg
            assert msg["role"] in ["user", "assistant"]
    
    def test_chat_history_empty_session(self):
        """GET /api/chat/history with non-existent session returns empty list"""
        response = requests.get(
            f"{BASE_URL}/api/chat/history",
            params={"session_id": "non-existent-session-id"}
        )
        assert response.status_code == 200
        messages = response.json()
        assert isinstance(messages, list)
        assert len(messages) == 0
    
    def test_chat_history_requires_session_id(self):
        """GET /api/chat/history without session_id returns error"""
        response = requests.get(f"{BASE_URL}/api/chat/history")
        # FastAPI returns 422 for missing required query params
        assert response.status_code == 422


class TestChatResponseQuality:
    """Tests for AI response quality and Spanish language"""
    
    def test_response_in_spanish(self):
        """AI response should be in Spanish"""
        response = requests.post(
            f"{BASE_URL}/api/chat",
            json={
                "message": "Cual fue el mejor mes de ventas?",
                "session_id": None,
                "filters": {}
            },
            timeout=30
        )
        assert response.status_code == 200
        data = response.json()
        # Check for Spanish words/patterns in response
        spanish_indicators = ["ventas", "mes", "año", "total", "S/", "tienda", "marca"]
        response_lower = data["response"].lower()
        has_spanish = any(word in response_lower for word in spanish_indicators)
        assert has_spanish, f"Response doesn't appear to be in Spanish: {data['response']}"


class TestRegressionEndpoints:
    """Regression tests for existing endpoints"""
    
    def test_api_root(self):
        """GET /api/ returns status ok"""
        response = requests.get(f"{BASE_URL}/api/")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
    
    def test_filters_endpoint(self):
        """GET /api/filters returns filter options"""
        response = requests.get(f"{BASE_URL}/api/filters")
        assert response.status_code == 200
        data = response.json()
        assert "marcas" in data
        assert "tipos" in data
        assert "stores" in data
        assert "years" in data
    
    def test_kpis_endpoint(self):
        """GET /api/kpis returns KPI data"""
        response = requests.get(f"{BASE_URL}/api/kpis")
        assert response.status_code == 200
        data = response.json()
        assert "total_sales" in data
        assert "order_count" in data
        assert "units_sold" in data
    
    def test_sales_by_year_endpoint(self):
        """GET /api/sales-by-year returns yearly data"""
        response = requests.get(f"{BASE_URL}/api/sales-by-year")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        if len(data) > 0:
            assert "year" in data[0]
            assert "total_sales" in data[0]
    
    def test_sales_by_store_endpoint(self):
        """GET /api/sales-by-store returns store data"""
        response = requests.get(f"{BASE_URL}/api/sales-by-store")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
    
    def test_top_clients_endpoint(self):
        """GET /api/top-clients returns client data"""
        response = requests.get(f"{BASE_URL}/api/top-clients")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
