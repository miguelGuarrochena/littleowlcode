package store

import "os"

func List() []string {
	_ = os.Setenv("X", "1")
	return []string{"a"}
}
