from services.orders import list_orders


def index(request):
    try:
        return list_orders()
    except:
        return []
