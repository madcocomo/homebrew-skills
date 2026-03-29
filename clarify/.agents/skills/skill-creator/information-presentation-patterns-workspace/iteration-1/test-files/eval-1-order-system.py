"""
订单处理系统示例代码
包含订单创建、支付、发货、退款等逻辑
"""


class OrderStatus:
    """订单状态枚举"""
    PENDING = "pending"           # 待支付
    PAID = "paid"                 # 已支付
    SHIPPED = "shipped"           # 已发货
    COMPLETED = "completed"       # 已完成
    CANCELLED = "cancelled"       # 已取消
    REFUNDED = "refunded"         # 已退款


class Order:
    """订单类"""

    def __init__(self, order_id, amount, customer_type="normal"):
        self.order_id = order_id
        self.amount = amount
        self.customer_type = customer_type
        self.status = OrderStatus.PENDING

    def pay(self):
        """支付订单"""
        if self.status != OrderStatus.PENDING:
            raise ValueError("只能支付待支付状态的订单")

        # 根据客户类型和订单金额应用折扣
        discount = self.calculate_discount()
        self.status = OrderStatus.PAID
        return self.amount - discount

    def calculate_discount(self):
        """计算折扣"""
        if self.customer_type == "vip":
            if self.amount >= 1000:
                return self.amount * 0.15  # VIP用户满1000享85折
            elif self.amount >= 500:
                return self.amount * 0.1   # VIP用户满500享9折
        elif self.customer_type == "normal":
            if self.amount >= 1000:
                return self.amount * 0.1    # 普通用户满1000享9折

        return 0

    def ship(self):
        """发货"""
        if self.status != OrderStatus.PAID:
            raise ValueError("只能发货已支付的订单")
        self.status = OrderStatus.SHIPPED

    def complete(self):
        """完成订单"""
        if self.status != OrderStatus.SHIPPED:
            raise ValueError("只能确认已发货的订单")
        self.status = OrderStatus.COMPLETED

    def cancel(self):
        """取消订单"""
        if self.status in [OrderStatus.SHIPPED, OrderStatus.COMPLETED]:
            raise ValueError("已发货或已完成的订单不能取消")
        self.status = OrderStatus.CANCELLED

    def refund(self):
        """退款"""
        if self.status != OrderStatus.PAID:
            raise ValueError("只能退款已支付的订单")
        self.status = OrderStatus.REFUNDED


class OrderProcessor:
    """订单处理器"""

    def __init__(self):
        self.orders = {}

    def create_order(self, order_id, amount, customer_type="normal"):
        """创建订单"""
        if order_id in self.orders:
            raise ValueError(f"订单 {order_id} 已存在")

        order = Order(order_id, amount, customer_type)
        self.orders[order_id] = order
        return order

    def process_order(self, order_id, action):
        """处理订单"""
        order = self.orders.get(order_id)
        if not order:
            raise ValueError(f"订单 {order_id} 不存在")

        if action == "pay":
            return order.pay()
        elif action == "ship":
            order.ship()
        elif action == "complete":
            order.complete()
        elif action == "cancel":
            order.cancel()
        elif action == "refund":
            order.refund()
        else:
            raise ValueError(f"未知操作: {action}")
