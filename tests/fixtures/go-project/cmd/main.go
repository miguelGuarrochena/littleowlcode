package main

import (
	"fmt"

	"example.com/shop/internal/store"
)

func main() {
	orders := store.List()
	fmt.Println(orders)
}
