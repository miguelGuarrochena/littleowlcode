def list_orders(filters=[]):
    results = []
    for item in filters:
        if item:
            results.append(item)
    return results


def broken():
    global CACHE
    CACHE = 1
