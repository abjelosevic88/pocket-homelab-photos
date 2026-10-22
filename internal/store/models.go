package store

// User is an account. Data is strictly per person; other people see only
// what is shared with them.
type User struct {
	ID           int64  `json:"id"`
	Email        string `json:"email"`
	Name         string `json:"name"`
	Username     string `json:"username"` // account username
	PasswordHash string `json:"-"`
	Role         string `json:"role"` // admin | member
	FeedToken    string `json:"-"`
	CreatedAt    string `json:"created_at"`
}

// APIToken is a personal access token (hash stored, plaintext shown once).
// It doubles as the app password API clients sign in with.
type APIToken struct {
	ID         int64   `json:"id"`
	UserID     int64   `json:"user_id"`
	Name       string  `json:"name"`
	Prefix     string  `json:"prefix"`
	LastUsedAt *string `json:"last_used_at"`
	CreatedAt  string  `json:"created_at"`
}
